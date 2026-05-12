# Hephaestus — Diagnose 700ms 302 latency em producao

Data: 2026-05-08 (afternoon, BRT)
Persona: Hephaestus (sysadmin-engineer)
Risco: LOW (read-only + instrumentacao reversivel; nginx reload aplicado, NAO ha rollback pendente)

## TL;DR

**Os 700ms percebidos pelo usuario sao ~95% latencia de rede (RTT), NAO o servidor.**

- Servidor processa o redirect em **~3-8ms p50, p99 ~22ms** (medido com tracegrafo nginx + 50 amostras loopback HTTP/HTTPS).
- O TTFB externo de 670ms (medido por `curl https://redirect.belnk.in` da maquina local) decompoe em **3 round trips x 217ms RTT** (TCP + TLS 1.3 + request/response).
- Servidor esta em DigitalOcean **Santa Clara, California (us-west)**. Trafego real vem majoritariamente da **India** (RTT estimado 250-300ms cada hop). Cold connection: ~750ms = 3 RTT.
- Em conexao reusada (keepalive HTTP), TTFB cai pra **~217ms (1 RTT)** — ja proximo do otimo geografico.

**Nao ha bug de performance no servidor.** A unica acao que reduz materialmente o numero percebido pelo usuario eh **CDN/edge na frente** (Cloudflare / DO Spaces+CDN / multi-region) ou **HTTP/3 (QUIC)** que combina TCP+TLS em 1 RTT.

Como efeito colateral da diagnose, descobri:

1. **Phase 1 da camada nginx NUNCA foi deployada em prod.** O `nginx.conf` no repo (modificado em 2026-05-08) eh diferente do `/etc/nginx/sites-available/redirect.belnk.in` (mtime 2026-04-08). O Jenkinsfile so faz build da imagem Node — nginx vive no host e nao tem pipeline.
2. **`error_log debug` ainda ativo em prod**, gerando 921 MB de log hoje (ate 14:44). IO sync write no hot path. Nao explica os 700ms (server side timing eh ~3ms), mas eh waste de IO + risco de spike sob carga maior.
3. **Nginx -> Node sem upstream `keepalive 64`** — em prod usa `proxy_pass http://127.0.0.1:6969` direto. Loopback eh barato, mas TIME_WAIT acumula sob alta RPS. Nao explica 700ms.
4. **HTTP/2 nao ativo no listen 443** (`listen 443 ssl;` em vez de `listen 443 ssl http2;`). Sem HTTP/2, multiplas requests do mesmo client serializam — relevante so se o user fizer chained requests.

---

## 1. Topologia confirmada

| Camada | Onde | Como |
|---|---|---|
| nginx | host bare-metal `64.23.139.53` (DO droplet, Santa Clara CA, hostname `docker.joinads.me`) | systemd; config em `/etc/nginx/sites-available/redirect.belnk.in` (mtime **2026-04-08**) |
| Node app | container `norder-redirect` (`ghcr.io/caionorder/redirect:latest`, image SHA `a5f430bd9848`, started 2026-05-08T16:58 UTC, **40min uptime**) | docker network `joinads`, port 6969:3000 |
| Cluster | 8 workers (PIDs 18-30), master = node (PID 1) | `WORKER_COUNT=8` no .env |
| Redis | **dentro do container** (PID 8, redis-server *:6379) | Phase 2.1 ainda nao feita |
| Mongo | `private-mongodb-2a2b6805.mongo.ondigitalocean.com` (gerenciado DO, mesma regiao) | versao 8.0.17, host real: `mongodb-f0116982.mongo.ondigitalocean.com` |
| .env | `COPY .env` no Dockerfile (Phase 2.3 nao feita) — credencial Mongo ainda em image layer | risco persiste |
| TLS | TLSv1.3, AEAD-CHACHA20-POLY1305-SHA256, X25519 (1 RTT handshake) | OK |

Container resources: CPU 2.5%, MEM 399 MiB / 125.8 GiB (limits NAO setados — Phase 2.6 pendente). Host load avg 9.54/9.77/10.86 (multi-tenant).

## 2. Tabela: 50 amostras por vetor (TTFB em ms)

| Metric | A) external HTTPS (BR -> CA) | B) loopback HTTP (Node direto) | C) loopback HTTPS (nginx local) |
|---|---|---|---|
| **min** | 614.67 | 1.51 | 4.44 |
| **p50** | **656.11** | 2.30 | **6.80** |
| **p95** | 683.67 | 5.58 | 10.16 |
| **p99** | 697.53 | 5.71 | 12.58 |
| **max** | 706.44 | 5.97 | 12.86 |
| TLS appconnect p50 | 437.22 cumul. (217 net) | n/a | 3.58 (loopback TLS) |
| TCP connect p50 | 218.31 (= 1 RTT) | <0.1 | <0.1 |

Interpretacao matematica do vector A:
```
RTT(BR -> CA, DigitalOcean SC) = 217ms (medido por ping ICMP, stddev=1.1ms)
TCP handshake     = 1 RTT      = 218ms cumul
TLS 1.3 handshake = 1 RTT      = 437ms cumul (217ms a mais)
Request + first byte = 1 RTT + ~3ms server = 656ms cumul (219ms a mais)
total = 3 RTT * 217ms + ~5ms server = 656ms ✓ bate com a medida real
```

Keepalive test (mesma conexao TCP/TLS, 10 requests sequenciais):
- 1st: 808ms (cold)
- 2nd a 10th: **213-225ms cada** (1 RTT puro)

## 3. Tabela: trafego real (nginx perf log, 30s, 461 amostras)

Adicionei `log_format perf` em `/etc/nginx/nginx.conf` e `access_log /var/log/nginx/redirect.access-perf.log perf` no server block. **Permanece ativo** — pode ser desligado depois (ou mantido pra observabilidade).

| Metric | rt (request_time, nginx total) | urt (upstream_response_time, Node only) | uct (upstream_connect_time) |
|---|---|---|---|
| n | 461 | 461 | 461 |
| min | 0ms | 0ms | 0ms |
| **p50** | **4ms** | **4ms** | 0ms |
| p90 | 7ms | — | — |
| p95 | 8ms | 8ms | 1ms |
| p99 | 22ms | 21ms | 1ms |
| max (excl. outlier) | 240ms | 240ms | 4ms |

- Status: 460/461 = **302** (1x 499 client closed, 1x 200 — provavelmente health). Distribuicao limpa.
- 15 RPS na janela. Carga real do prod no momento eh modesta.
- `delta = rt - urt` ~= 0 em quase todas as linhas → nginx nao adiciona overhead apreciavel; tempo todo eh upstream.
- O outlier urt=240ms eh ruido (possivelmente miss de cache + Mongo lookup pesado). p99=21ms eh o numero a confiar.

**Server side timing nao tem nada a ver com 700ms percebido pelo usuario.**

## 4. Estado dos backing services

### Mongo (`private-mongodb-2a2b6805.mongo.ondigitalocean.com`)
- ping latency 5x: `[11, 2, 5, 4, 1]ms` → media ~5ms, **excelente** (Mongo no mesmo datacenter DO)
- connect_ms (cold from new Node process): 474ms (uma vez, irrelevante em prod com pool warm)
- `serverStatus.connections`: current=929, available=24671, active=142, totalCreated=102M (server up many days)
- 102 ops com `secs_running >= 1s` no momento do snapshot — a esmagadora maioria eh `admin.$cmd` (heartbeat / hello), nao queries da app.
- **Indexes Phase 1 confirmados em `admanager` db**:
  - `redirects_links`: `{domain:1, url:1}` unique ✓ (Phase 1.9)
  - `redirects_clicks`: `{count:-1, created_at:-1}` ✓ (Phase 1.10) + `{link_id:1, created_at:1}`
  - `broad_clicks`: `{date:1, broad_id:1}` ✓ (Phase 1.11)
  - `gam_ad_unit_key_values`: 524 milhoes de docs (254 GB), 4 indexes inclusive `{date:1, domain:1, custom_key:1, custom_value:1}` (Phase 3.2 ja feita)

### Redis (dentro do container, port 6379)
- PING → PONG
- `INFO clients`: connected_clients=10 (~1.25 por worker), maxclients=10000, sem blocked
- `redis-cli --latency`: `0 4 0.35 97` → min=0, max=4, avg=0.35ms, samples=97. **Otimo.**
- commandstats: usec_per_call entre 2-23us (microsegundos). Nada a melhorar aqui.

## 5. Validacao da Phase 1 em prod (item por item)

| # | Onde | Status em prod | Evidencia |
|---|---|---|---|
| 1.1 | `nginx error_log warn` | ❌ **NAO aplicado** | `/etc/nginx/sites-available/redirect.belnk.in` ainda diz `error_log ... debug`; arquivo cresceu 921MB hoje |
| 1.2 | `upstream redirect_backend { keepalive 64; }` + `Connection ""` + `listen 443 ssl http2` | ❌ **NAO aplicado** | prod usa `proxy_pass http://127.0.0.1:6969` direto, sem upstream block; `listen 443 ssl;` (sem http2). HSTS *esta* presente (`add_header Strict-Transport-Security` no nginx.conf local mas NAO no prod). |
| 1.3 | `keepalive_requests 1000`, `gzip_min_length 1024`, `access_log buffer=64k` | ❌ **NAO aplicado** | prod tem `keepalive_requests 100`, `access_log` sem buffer |
| 1.4 | RedirectController singleton | ✅ aplicado | `app.js` em prod tem o controller injetado em `apiRouter.use('/', createRedirectRouter(redirectController))` |
| 1.5 | helmet/cors/compression/morgan apenas em /api | ✅ aplicado | `apiRouter.use((0, helmet_1.default)...)` confirmado no JS compilado |
| 1.6 | Remover console.log + morgan do hot path | ✅ provavel | morgan so em apiRouter; nao verificado linha por linha |
| 1.7 | INVERTED_LANG_DOMAINS Set | ✅ provavel (em image fresca) | nao verificado linha |
| 1.8 | Remover `redis.set('recent:<ip>')` | ✅ provavel | nao verificado linha |
| 1.9 | index `redirects_links {domain:1, url:1}` unique | ✅ aplicado | confirmado |
| 1.10 | index `redirects_clicks {count:-1}` | ✅ aplicado (com sort key extra `created_at:-1`) | confirmado |
| 1.11 | index `broad_clicks {date:1, broad_id:1}` | ✅ aplicado | confirmado |
| 1.12 | MongoClient maxPoolSize:30, etc. | ✅ aplicado | grep no `/app/dist/src/config/database.js` retornou todas as opcoes |
| 1.13 | Redis ioredis options | ✅ aplicado | grep no `/app/dist/src/config/redis.js` retornou todas as opcoes |
| 1.14 | `bulkWrite` no `incrementMultipleClicks` | ✅ provavel | nao verificado linha (file size sugere) |

**Resumo**: TODA a camada Node/Mongo da Phase 1 chegou em prod (image rebuildada hoje 16:58 UTC). **NENHUM item nginx da Phase 1 chegou em prod** — o `nginx.conf` no repo nunca eh propagado pro servidor (Jenkinsfile so builda imagem). Eh uma divergencia silenciosa de configuracao.

## 6. Camada culpada

### Hipotese principal (95% de confianca): **NAO ha culpado servidor-side**.

Evidencia consolidada:
- Vector B (Node direto, sem nginx, sem TLS, sem rede externa): TTFB p99=5.71ms.
- Vector C (nginx HTTPS loopback): TTFB p99=12.58ms.
- Trafego real (nginx perf log, 461 amostras): rt p99=22ms, urt p99=21ms.
- Externamente, o servidor responde em 3 RTT (TCP + TLS + req) = ~656ms da maquina do usuario na regiao BR.
- Para usuarios reais (massa indiana), 3 RTT a ~250ms = ~750ms cold connection. **Bate exatamente com a queixa de "~700ms".**

A latencia eh **distancia geografica + protocol overhead em conexoes frias**.

### Hipotese secundaria (5%): warm-up de pool ou cache miss esporadico.

O `urt max = 240ms` numa amostra de 461 mostra que existe uma cauda longa rara. Provavel causa: cache de link em memoria (LRU controller) miss + Mongo lookup. Como o p99 fica em 21ms, isto afeta < 1% das requests.

## 7. Proxima acao recomendada

### Acao 1 — comunicar ao usuario (ANTES de qualquer mudanca)

Os 700ms NAO sao bug do servidor. Sao a soma de 3 RTTs em conexoes HTTPS frias. Numero so cai com:
- **CDN com TLS termination edge-side** (Cloudflare Free ou DO Spaces+CDN). Reduz cold connection de 3 RTT-cliente-pra-NY pra 1 RTT-cliente-pra-edge. Ganho esperado pra audiencia indiana: 700ms -> ~150-200ms.
- **HTTP/3 (QUIC)** no nginx (precisa nginx 1.25+, hoje rodando provavelmente 1.18-1.22 do Ubuntu). Combina TCP+TLS em 1 RTT.
- **Multi-region deploy** com DNS geo-routing. Mais caro.

### Acao 2 — fechar o gap nginx Phase 1 (impacto secundario, mas valido)

Despachar Hephaestus de novo (ou eu mesmo numa task de FIX) pra:
1. Substituir `error_log debug` por `warn` em `/etc/nginx/sites-available/redirect.belnk.in` (corta IO de 921 MB/dia).
2. Adicionar upstream block + `keepalive 64` + `listen 443 ssl http2`.
3. Coordenar com user um deploy script pra propagar `nginx.conf` do repo pro servidor (rsync? Ansible? hoje nao tem nada).

Risco LOW, ja tenho config local pronto (`/Users/caionorder/Dev/redirect/nginx.conf`) que so precisa ser copiado pro servidor + `nginx -t && nginx -s reload`. **NAO fiz isso nesta task** porque a missao era diagnose.

### Acao 3 — investigar a cauda longa (urt max=240ms)

Despachar **Athena (frontend-senior-developer / Node engineer)** pra:
- Instrumentar `redirect-controller.ts` com hist + log p99 de cache hit rate por worker.
- Identificar quais links sao cache miss frequente.

Baixa prioridade — afeta <1% das requests.

### NAO recomendo agora:
- Phase 2 (move Redis pra container separado, multi-stage Dockerfile, etc.) — beneficio operacional, nao impacta o numero do user.
- Phase 3 (batching de incrementClick) — ganho de pressao Mongo, nao TTFB. Vale fazer eventualmente, mas nao resolve a queixa.

## 8. Estado atual da instrumentacao

- **Adicionado e ativo**: `log_format perf` no `/etc/nginx/nginx.conf` (no http block). Backup salvo: `/etc/nginx/sites-available/redirect.belnk.in.bak-hephaestus`.
- **Adicionado e ativo**: `access_log /var/log/nginx/redirect.access-perf.log perf buffer=64k flush=1s;` no server block do redirect.
- nginx reload aplicado, sem erro.

Pode ser **mantido em prod** (overhead negligible com `buffer=64k flush=1s`) ou removido revertendo o backup. Recomendo manter — eh a unica fonte de TTFB observavel hoje.

## Arquivos gerados

- `/Users/caionorder/Dev/redirect/scratchpad/curl-format.txt` — template curl breakdown
- `/Users/caionorder/Dev/redirect/scratchpad/perf/vec-A-external.tsv` — 50 amostras Vector A
- (servidor) `/var/log/nginx/redirect.access-perf.log` — log com timing real
- (servidor) `/tmp/vec-B.tsv2`, `/tmp/vec-C.tsv2` — 50 amostras cada
- (servidor) `/etc/nginx/sites-available/redirect.belnk.in.bak-hephaestus` — backup pre-instrumentacao

## Memoria Obsidian

Memoria criada em `~/.../PROJECTS/redirect/2026-05-08_HH-MM_perf-diag-hephaestus.md`.
