# Plano de Performance — redirect

Consolidacao dos relatorios: `agent-hera.md` (codigo TS/Express), `agent-poseidon.md` (Mongo/Redis), `agent-hephaestus.md` (Docker/Nginx/CI).

Servico HTTP de redirect latency-critical (TTFB e a metrica que importa). Existem ganhos rapidos significativos antes de qualquer refactor profundo.

---

## ACAO IMEDIATA — credenciais expostas

**Antes de qualquer otimizacao, rotacionar a credencial Mongo `b019C7Fyc4P35hg8`.** Esta hardcoded no `Jenkinsfile:30` e copiada pra image layer via `Dockerfile:19` (`COPY .env`). Esta acessivel a quem puxar `ghcr.io/caionorder/redirect:latest`.

---

## FASE 1 — Quick wins (impacto alto, esforco baixo, mesmo dia)

| # | Onde | Mudanca | Impacto |
|---|------|---------|---------|
| 1.1 | `nginx.conf` | Trocar `error_log debug` por `warn` (linha 6) | IO sync no hot path → alivio imediato |
| 1.2 | `nginx.conf` | Adicionar `upstream redirect_backend { keepalive 64; }` + `proxy_set_header Connection ""` (sem 'upgrade') + `listen 443 ssl http2` | -1 a -3ms no p50, elimina TIME_WAIT e port exhaustion |
| 1.3 | `nginx.conf` | `keepalive_requests 1000`, `gzip_min_length 1024`, `access_log ... buffer=64k flush=5s` | Reduz custo de log + gzip inutil em 301/302 |
| 1.4 | `src/routes/redirect-route.ts:7` + `src/app.ts:97-106` | **RedirectController singleton** — instanciar 1x em `app.ts`, injetar em `createRedirectRouter(controller)`. Hoje sao 2 instancias por worker = cron duplicado, cache fragmentado, 2x WP-VALIDATE no boot. | Dobra hit rate de cache em memoria, elimina cron duplo |
| 1.5 | `src/app.ts:21-57` | Mover `helmet`, `cors`, `compression`, `express.json`, `express.urlencoded` para `app.use('/api', ...)`. Hot path so com `trust proxy` + `etag false` (ja ok). | Tira ~5 middlewares por redirect |
| 1.6 | `src/app.ts:38` + `src/controllers/redirect-controller.ts` | Remover `morgan` do hot path. Remover `console.log [DEBUG INAPP]` linha 1021 e `JSON.stringify(inAppRules.map(...))` linha 1024. Remover `console.log [CLICK RECORDED ...]` linhas 1145/1150/1281/1286. | Drena event loop sob carga; sync writes em pipe Docker stdout |
| 1.7 | `src/controllers/redirect-controller.ts:1102` | `INVERTED_LANG_DOMAINS` virar `static readonly Set`. So instanciar `new URL()` se hostname (substring) estiver no set. | Zero alocacao por request no fast-path |
| 1.8 | `src/controllers/redirect-controller.ts:1156, 1292` | Remover `redis.set('recent:<ip>', ..., 'EX', 5)` — chave nunca e lida (dead write). | -1 RTT Redis por redirect |
| 1.9 | Criar `migrations/001-redirects-links-indexes.ts` | `db.redirects_links.createIndex({domain:1, url:1}, {unique:true, background:true})`. `getLinkByDomainAndUrl` hoje e COLLSCAN. | BLOCKER por Poseidon — admin CRUD destravado |
| 1.10 | Criar `migrations/002-redirects-clicks-count-index.ts` | `db.redirects_clicks.createIndex({count:-1}, {background:true})`. | Tira sort em memoria de `getAllClicks`, `getTopClicks` |
| 1.11 | Criar `migrations/003-broad-clicks-date-index.ts` | `db.broad_clicks.createIndex({date:1, broad_id:1}, {background:true})`. Indice atual `(broad_id,date)` nao serve para `getClicks(start,end)` que filtra so por date. | Aggregation `getClicks` deixa de ser COLLSCAN |
| 1.12 | `src/config/database.ts` | Adicionar `MongoClient` options: `maxPoolSize:30`, `minPoolSize:5`, `serverSelectionTimeoutMS:5000`, `socketTimeoutMS:20000`, `waitQueueTimeoutMS:2000`, `appName:'redirect'`, `retryReads:true`, `writeConcern:{w:1}`. Hoje cluster com 8 workers x default 100 = 800 conns potenciais. | Blinda contra hangs e estouro de pool |
| 1.13 | `src/config/redis.ts` | `connectTimeout:5000`, `commandTimeout:2000`, `maxRetriesPerRequest:3`, `enableOfflineQueue:false`, `keepAlive:30000`. | Worker nao pendura quando Redis degrada |
| 1.14 | `src/repositories/redirect-click-repository.ts:209-228` | `incrementMultipleClicks` com `bulkWrite([...], { ordered:false })` em vez de loop de `updateOne`. | N RTTs → 1 RTT |

**Smoke test pos-fase1**: `wrk -t8 -c500 -d30s http://localhost:3000/?utm_source=x` antes/depois. Baseline esperado: queda de p50 e p99 perceptivel.

---

## FASE 2 — Infra critica (mesmo sprint)

| # | Mudanca | Por que |
|---|---------|---------|
| 2.1 | **Tirar Redis do container do app**. Subir `redis:7-alpine` separado na mesma network `joinads`, com `maxmemory` + `allkeys-lru`. Node aponta via `REDIS_HOST` env. | Redis no container quebra scaling horizontal, compete CPU com workers, quebra signal handling. |
| 2.2 | **Multi-stage Dockerfile** + `FROM node:22-alpine` (LTS) + `tini` como ENTRYPOINT + `USER node`. | Resolve PID 1 (sh nao propaga SIGTERM), reduz image size, fixa Node em LTS, non-root. |
| 2.3 | **Remover `COPY .env`** do Dockerfile + remover `Create Environment File` stage do Jenkinsfile. Passar via `docker run -e VAR=$VAR` com `withCredentials([string(credentialsId:'mongodb-url', ...)])`. | Para o vazamento de credenciais via image layer. |
| 2.4 | Criar `.dockerignore` (`node_modules`, `dist`, `.git`, `.env*`, `scratchpad`, `*.md`). | Build mais rapido + image enxuta. |
| 2.5 | **Graceful shutdown no `cluster.ts`** — handler SIGTERM/SIGINT no master, propaga pros workers, workers chamam `server.close()` antes de exit. Adicionar circuit breaker no respawn (max 10 crashes/60s). | Deploy nao corta requests em flight. |
| 2.6 | **`docker run` com limits**: `--memory=2g --cpus=4 --ulimit nofile=65535:65535 --pids-limit=512`. | Container nao estoura host. |
| 2.7 | **WORKER_COUNT dinamico**: remover do `.env`, deixar fallback `os.cpus().length` em `cluster.ts`, ou setar via `docker run -e WORKER_COUNT=$(nproc)`. | 8 fixo nao bate com host real. |

---

## FASE 3 — Reducao de pressao no Mongo (medio prazo)

| # | Mudanca | Por que |
|---|---------|---------|
| 3.1 | **Batching de `incrementClick` via Redis** — controller acumula em `HINCRBY clicks:counters $linkId 1` e `HINCRBY broad:counters $broadId 1` no hot path. Cron de 30-60s consolida via `bulkWrite` no Mongo. | Hoje cada redirect = 2 `findOneAndUpdate` upsert no Mongo (linhas 1144, 1148, 1280, 1284). Em alta RPS, transforma 2*RPS writes em 2 a cada 30s. **Maior ganho de pressao DB do plano.** |
| 3.2 | Criar `migrations/004-gam-ad-unit-indexes.ts` (validar tamanho da colecao primeiro): `db.gam_ad_unit_key_values.createIndex({date:1, domain:1, custom_key:1, custom_value:1}, {name:'date_domain_key_value', background:true})` + `{date:1, domain:1}`. | Cron de 15 min em `BuilderService.build` faz `$match` por estes campos sem indice. |
| 3.3 | `BuilderService.build` — passar `{ allowDiskUse: true, readPreference: 'secondaryPreferred' }` no `aggregate`. Mover `$toInt`/`$toDouble` pra ETL upstream se viavel. | Pipeline atual aborta se `$group` exceder 100MB. Tipos numericos canonicos eliminam conversao por row. |
| 3.4 | `getStats`, `getDataByPeriod`, `getClickCountsBySuffixes`, `getTopClicks` — adicionar `readPreference: 'secondaryPreferred'`. | Aggregations pesadas saem do primary. |
| 3.5 | `getAllClicks` (`redirect-click-repository.ts:69-75`) — paginacao por cursor (`{count:{$lt:lastCount}}`) em vez de `skip(offset)`. | Deep paging com skip e O(n). |
| 3.6 | `getStats`/`getTotalClicksSum` — cache 60s em Redis. | Aggregate full-scan a cada chamada do painel. |
| 3.7 | `domain-group-service.ts:117, 125` — memoizar `getActiveSlugs()` e `getAllDomains()` (cachear array, invalidar no `refreshCache()`). Expor `getActiveSlugsSync()`. Catch-all em `app.ts:128-152` deixa de pagar microtask. | Hot path catch-all puramente sincrono no fast-path. |

---

## FASE 4 — Estrutural (refactor maior, fazer com benchmark)

| # | Mudanca | Por que |
|---|---------|---------|
| 4.1 | **Cron em processo dedicado** — adicionar workerType=cron no `cluster.ts` (worker que nao faz `app.listen`, so executa schedules). Hoje worker 1 serve redirects E executa cron pesada (`fetchAllValidPosts`, `pageviews em batches`) → TTFB do worker 1 sobe durante execucao. | Isola CPU do hot path. |
| 4.2 | **Denormalizar `domain` e `post_id` em `redirects_clicks`** — gravar no momento do `incrementClick`. Indice `{domain:1, post_id:1}`. Reescrever `getClickCountsBySuffixes` (`redirect-click-repository.ts:236-296`) com `$match` direto, sem `$let`/`$reduce`/regex. Migration de backfill. | Hoje pipeline e regex `_${suffix}$` sem ancora = COLLSCAN + CPU Mongo. |
| 4.3 | **TTL/archive em `redirects_clicks` e `broad_clicks`** — depende de decisao de produto: `count` cumulativo + TTL apaga historico. Alternativa: bucketing por dia (`{link_id, day, count}`). Validar com stakeholder. | Crescimento sem fim. |
| 4.4 | **Blue-green deploy no Jenkinsfile** — 2 containers em portas 6969/6970, nginx upstream com flag `down`/`up`, healthcheck antes de swap, depois `nginx -s reload`. | Hoje `docker stop && docker run` = blackout 5-15s por deploy. |
| 4.5 | **Docker BuildKit cache** no `docker buildx build` — `--cache-from`/`--cache-to` em registry tag `:buildcache`. | Build do zero a cada commit (~2-5min de waste). |
| 4.6 | **Rate limit no nginx** — `limit_req_zone $binary_remote_addr zone=redirect_per_ip:10m rate=200r/s; limit_req zone=redirect_per_ip burst=400 nodelay;`. | Nginx dropa antes de chegar no Node em DDoS/scrape abusivo. |
| 4.7 | **Healthcheck que valida Redis** — `/health` retorna 503 se `redis.ping()` falhar. | Hoje Node responde 200 com Redis morto = degradacao silenciosa. |

---

## Dependencias entre fases

- **Fase 1.4 (singleton controller) bloqueia Fase 3.1 (batching).** Sem singleton, cada instancia teria seu proprio buffer e a contagem fica fragmentada.
- **Fase 1.13 (`enableOfflineQueue:false`) precisa de revisao do codigo Redis** — chamadas atuais nao tem `try/catch` no hot path. Validar que `if (!this.redisClient)` cobre o caso de erro.
- **Fase 2.1 (Redis fora do container) afeta env do Node** — `REDIS_HOST` precisa apontar pra novo container/IP. Coordenar com Fase 2.3 (env via `docker run -e`).
- **Fase 3.2 (indice em `gam_ad_unit_key_values`)** — confirmar tamanho da colecao com DBA antes. Criacao em colecao grande exige janela de manutencao mesmo com `background:true`.
- **Fase 3.7 (sync getActiveSlugs) sem Fase 1.5 (mover middlewares)** ainda paga overhead — fazer 1.5 antes.

---

## Recomendacao de execucao

1. **Hoje**: rotacionar credencial Mongo + aplicar Fase 1 inteira (1 sprint curto, sem tocar infra).
2. **Esta semana**: Fase 2 (infra), com janela de deploy reservada — varias mudancas mexem em CMD/ENTRYPOINT do container.
3. **Proximo sprint**: Fase 3, comecando pelo batching (3.1 — maior ROI). Resto pode vir incremental.
4. **Backlog estrategico**: Fase 4 com benchmark antes/depois de cada item.

---

## Quem implementa o que

- **Codigo TS** (Fases 1.4-1.8, 1.12-1.14, 3.5, 3.7, 4.1, 4.2 — refactor) → `frontend-senior-developer` (Athena) ou um Node engineer dedicado. **Nao ha agente Node.js dedicado no time atual.**
- **Migrations Mongo** (Fases 1.9-1.11, 3.2, 4.2-backfill) → `database-engineer` (Poseidon).
- **Nginx + Dockerfile + Jenkinsfile** (Fases 1.1-1.3, 2.x, 4.4-4.7) → `sysadmin-engineer` (Hephaestus).
- **Code review pre-merge** de cada PR → `code-reviewer` (Hera).
- **Audit das mudancas de credencial e CSP** → `security-reviewer` (Aegis).

---

## Metricas a instrumentar antes de medir

- TTFB p50/p95/p99 no nginx (`access_log` com `$request_time` e `$upstream_response_time`).
- Hit rate dos caches em memoria do controller (contador). Esperado pos-Fase1.4: >95%.
- `db.serverStatus().connections` no Mongo antes/depois da Fase 1.12.
- `INFO clients`/`INFO commandstats` no Redis antes/depois das Fases 1.13, 3.1.
- Throughput RPS por worker (process metrics) — confirmar que cluster.ts hardcoded de 8 nao esta over-subscribing CPU.

---

## Referencias

- `scratchpad/agent-hera.md` — analise codigo TS
- `scratchpad/agent-poseidon.md` — analise Mongo/Redis
- `scratchpad/agent-hephaestus.md` — analise Docker/Nginx/CI
