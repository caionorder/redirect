# Hephaestus — Infra Performance Review (redirect)

Servico HTTP redirect latency-critical, alto volume, cluster mode Node + Redis in-container atras de Nginx + Certbot, build via Jenkins → GHCR → SSH deploy. Stack tem varias armadilhas de performance e operacao.

---

## Dockerfile

### [BLOCKER] Redis dentro do container — anti-pattern grave
- **Onde:** `Dockerfile:3-4`, `Dockerfile:34`
- **Problemas:**
  1. **Nao escala horizontal:** cada replica do container tem Redis isolado → estado de cache fragmentado. Se voce subir 2+ instancias atras de LB, cada uma vai com cache frio diferente → race conditions em invalidacoes, hit-ratio cai.
  2. **Sem persistencia / config:** `redis-server --daemonize yes` nao define `maxmemory`, `maxmemory-policy`, `save`, `appendonly`. Risco de OOM matando o container inteiro (Redis + Node juntos).
  3. **Compete recursos com Node cluster:** `WORKER_COUNT=8` (Jenkinsfile:33) + Redis no mesmo container = 9 processos disputando CPU/mem do mesmo cgroup. Em pico, Redis `BGSAVE` (se habilitar) ou eviction stalls afetam latencia dos workers.
  4. **Lifecycle acoplado:** crash do Redis nao reinicia, fica zombie (porque PID 1 e `sh` — ver proximo finding).
- **Fix:** subir Redis como container separado (`docker run --name redirect-redis redis:7-alpine ...`) na mesma `--network joinads`, configurar `maxmemory` + `allkeys-lru`. Node aponta pra `redis://redirect-redis:6379` via env var.

### [BLOCKER] PID 1 e `sh`, signal handling quebrado
- **Onde:** `Dockerfile:34` — `CMD ["sh", "-c", "redis-server --daemonize yes && node dist/index.js"]`
- **Problema:** com `--daemonize yes`, redis-server fork+detach. Node roda em foreground sob `sh`. **PID 1 = sh**, nao node. Quando Docker manda SIGTERM (deploy/restart), vai pra `sh`, que NAO propaga pros filhos. Node cluster master nao recebe sinal → workers nao fazem graceful shutdown → conexoes em flight sao cortadas mid-redirect.
- **Tambem:** sem reaping de zumbis. Se workers do cluster morrerem rapidamente (loop de respawn), defunct processes acumulam.
- **Fix:** usar `tini` ou `dumb-init` como entrypoint. Idealmente split em containers separados. Se ficar junto: `RUN apk add --no-cache tini` + `ENTRYPOINT ["/sbin/tini", "--"]` + CMD invocando script que faz `exec node dist/index.js` (Redis em container separado).

### [BLOCKER] `.env` copiado pra dentro da imagem
- **Onde:** `Dockerfile:19` — `COPY .env .env`
- **Problemas:**
  1. **Secrets na image layer** — qualquer um com pull do `ghcr.io/caionorder/redirect:latest` extrai o `MONGODB_URL` com password (`b019C7Fyc4P35hg8` — vista no Jenkinsfile:30). Mesmo deletando depois, fica nas layers anteriores.
  2. **Cache bust catastrofico:** toda mudanca no `.env` invalida a layer + tudo abaixo (`npm install --only=dev`, `npm run build`, `npm prune`). Build fica lento sem motivo.
- **Fix:** remover `COPY .env`. Passar via `docker run -e VAR=value` (Jenkinsfile linha 63) ou Docker secrets / `--env-file` (mais seguro). Rotacionar a credencial Mongo agora — assuma que vazou.

### [HIGH] Sem multi-stage build
- **Onde:** `Dockerfile` inteiro
- **Problemas:**
  1. Imagem final carrega `src/`, `tsconfig.json`, `.env`, todo o git context (`COPY . .` linha 16).
  2. Fluxo `npm ci --only=production` (13) → `npm install --only=dev` (22) → `npm prune --production` (24) instala dependencias **duas vezes**. ~30-60s desperdicados por build em projeto medio.
- **Fix:** padrao multi-stage:
  ```dockerfile
  FROM node:22-alpine AS builder
  WORKDIR /app
  COPY package*.json tsconfig.json ./
  RUN npm ci
  COPY src ./src
  RUN npm run build

  FROM node:22-alpine AS runner
  WORKDIR /app
  RUN apk add --no-cache tini
  COPY package*.json ./
  RUN npm ci --omit=dev && npm cache clean --force
  COPY --from=builder /app/dist ./dist
  USER node
  ENTRYPOINT ["/sbin/tini", "--"]
  CMD ["node", "dist/index.js"]
  ```

### [HIGH] Node 23 (nao-LTS) em producao
- **Onde:** `Dockerfile:1` — `FROM node:23-alpine`
- **Problema:** Node 23 e odd-numbered → supporte ate ~Jun/2025. Patches de security tem janela curta. Para servico latency-critical em prod, usar LTS (`node:22-alpine` — Active LTS ate Out/2027).
- **Fix:** `FROM node:22-alpine`.

### [HIGH] Nao roda como non-root
- **Onde:** `Dockerfile` inteiro (sem `USER`)
- **Problema:** processo roda como root no container. Se houver RCE no Express (parser, dep vulneravel), atacante tem root no container + acesso a `/app/.env`.
- **Fix:** adicionar `USER node` (image alpine ja tem o user). Garantir que `/app` seja `chown node:node`.

### [MED] HEALTHCHECK so cobre Node, ignora Redis
- **Onde:** `Dockerfile:30-31`
- **Problema:** se Redis crashar (OOM, segfault), Node fica respondendo `/health` 200 mas todas as operacoes de cache falham → latencia degrada silenciosamente. Container nunca e reiniciado pelo Docker.
- **Fix:** apos separar Redis em container, healthcheck do Node deveria pingar Redis tambem (ex: `/health` retorna 503 se `redis.ping()` falhar). Healthcheck do container Redis e nativo (`redis-cli ping`).

### [MED] `apk add redis` sem pin de versao
- **Onde:** `Dockerfile:3-4`
- **Problema:** build nao reproduzivel. Versao muda quando Alpine atualiza repo.
- **Fix:** Redis fora do container resolve. Se manter, `RUN apk add --no-cache redis=7.2.4-r0` (ajustar pra versao Alpine atual).

### [LOW] Sem `.dockerignore`
- **Problema:** `COPY . .` (linha 16) traz `node_modules/` local (se existir), `.git/`, `dist/` antigo, `scratchpad/`, etc. Lentidao + cache bust.
- **Fix:** criar `.dockerignore` com `node_modules`, `dist`, `.git`, `.env*`, `scratchpad`, `*.md`, `coverage`, `.vscode`.

---

## Nginx

### [BLOCKER] Sem upstream keepalive — nova conexao TCP por request
- **Onde:** `nginx.conf:25` — `proxy_pass http://127.0.0.1:6969$request_uri` direto, sem `upstream` block
- **Problema:** em high-traffic, cada request faz `TCP SYN/SYN-ACK/ACK + close` pro backend. Em ~15k rps voce gera ~30k port-recycles/sec → port exhaustion + TIME_WAIT inflado + ~0.3-1ms a mais de TTFB por request gratuito. Pra redirect latency-critical isso e o single biggest win.
- **Agravante:** `proxy_set_header Connection 'upgrade'` (linha 29) **forca** o nginx a NAO reusar conexao mesmo se voce adicionasse keepalive. Esse header so deveria existir em rotas WebSocket condicionais.
- **Fix:**
  ```nginx
  upstream redirect_backend {
      server 127.0.0.1:6969;
      keepalive 64;
      keepalive_requests 10000;
      keepalive_timeout 60s;
  }

  server {
      ...
      location / {
          proxy_pass http://redirect_backend;
          proxy_http_version 1.1;
          proxy_set_header Connection "";   # esvazia, NUNCA "upgrade" pra HTTP normal
          ...
      }
  }
  ```

### [BLOCKER] `error_log debug` em producao
- **Onde:** `nginx.conf:6` — `error_log /var/log/nginx/redirect.error.log debug;`
- **Problema:** debug log gera dezenas de linhas por request, IO sincrono, derruba IOPS, pode encher disco em horas em high-traffic. Tambem expoe headers/internals em log file (security).
- **Fix:** `error_log /var/log/nginx/redirect.error.log warn;`

### [HIGH] HTTP/2 nao habilitado
- **Onde:** `nginx.conf:54` — `listen 443 ssl;`
- **Problema:** clientes modernos abrem ate 6 conexoes HTTP/1.1 paralelas pro mesmo host. HTTP/2 multiplexa em 1 conexao → menos handshakes TLS, menos memoria por client no nginx, menor latencia em retries.
- **Fix:** `listen 443 ssl http2;` (sintaxe Certbot-friendly). Em nginx 1.25.1+ usar `listen 443 ssl; http2 on;`.

### [HIGH] `access_log` sincrono sem buffer
- **Onde:** `nginx.conf:5` — `access_log /var/log/nginx/redirect.access.log;`
- **Problema:** em alta carga, write sincrono no log file vira gargalo de IO. Bloqueia worker.
- **Fix:** ou `access_log off;` (se Node ja loga), ou `access_log /var/log/nginx/redirect.access.log main buffer=64k flush=5s;`. Definir formato `main` no `http {}` block global se ja nao existir.

### [HIGH] Sem rate limiting na camada nginx
- **Problema:** brief mencionou que rate limit esta no Node. Em DDoS / scraping abusivo, Node cluster gasta CPU so pra retornar 429. Nginx pode dropar antes.
- **Fix:**
  ```nginx
  limit_req_zone $binary_remote_addr zone=redirect_per_ip:10m rate=200r/s;
  limit_req_status 429;

  server {
      location / {
          limit_req zone=redirect_per_ip burst=400 nodelay;
          ...
      }
  }
  ```
  Definicao de `limit_req_zone` precisa ir no `http {}` block global, nao no server.

### [MED] `gzip_min_length 10` over-zealous para redirects 301
- **Onde:** `nginx.conf:46`
- **Problema:** redirects HTTP 301/302 sem corpo (ou com corpo HTML default minusculo) ainda passam por gzip → CPU desperdicado, payload pode ate ficar **maior** que o original (overhead de header gzip ~20 bytes).
- **Fix:** `gzip_min_length 1024;`. Pra redirects sem body, gzip e irrelevante mesmo.

### [MED] `proxy_buffering off` + `proxy_buffers` configurado = config inconsistente
- **Onde:** `nginx.conf:9, 37-38`
- **Problema:** com `proxy_buffering off`, `proxy_buffers 8 16k` e `proxy_buffer_size 32k` sao ignorados (so `proxy_buffer_size` ainda controla buffer da resposta inicial do upstream). Codigo morto, polui config.
- **Decisao:** pra redirects pequenos `proxy_buffering off` faz sentido (TTFB direto). Manter, mas deletar `proxy_buffers 8 16k` que nao tem efeito.

### [MED] `keepalive_requests 100` baixo para alta carga
- **Onde:** `nginx.conf:10`
- **Problema:** valor padrao do nginx e 1000. 100 forca client a renegociar conexao a cada 100 requests.
- **Fix:** `keepalive_requests 1000;` (ou 10000 em high-traffic).

### [MED] SSL config dependente de Certbot — verificar TLS version
- **Onde:** `nginx.conf:57` — `include /etc/letsencrypt/options-ssl-nginx.conf;`
- **Acao:** validar que esse include forca TLS 1.2+ apenas e ciphers modernos (ECDHE+AESGCM+CHACHA20). Em maquinas antigas pode estar permitindo TLS 1.0/1.1.
- **Fix:** se necessario, sobrescrever apos o include:
  ```nginx
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;
  ssl_session_cache shared:SSL:50m;
  ssl_session_timeout 1d;
  ssl_session_tickets off;
  ```

### [LOW] Server block HTTP retorna 404 em vez de 301
- **Onde:** `nginx.conf:61-73`
- **Problema:** `if ($host = redirect.belnk.in)` redireciona pra HTTPS, mas para hosts wildcard (`~^(redirect|security|link)\\..+\\..+$`) retorna 404 em HTTP. Clientes em HTTP nao funcionam com esses hostnames wildcard.
- **Fix:** se o servico aceita HTTPS-only via wildcard, ok. Se deveria redirecionar todos pra HTTPS, usar `return 301 https://$host$request_uri;` direto.

### [LOW] `proxy_pass http://127.0.0.1:6969$request_uri` — `$request_uri` redundante
- **Onde:** `nginx.conf:25`
- **Problema:** quando location e `/` sem trailing slash no proxy_pass, nginx ja preserva o URI completo. Adicionar `$request_uri` pode dobrar a query string em alguns casos edge.
- **Fix:** apos mover pra upstream block, ficar so `proxy_pass http://redirect_backend;`.

---

## Cluster mode (Node)

### [HIGH] `WORKER_COUNT=8` hardcoded sem coerencia com host
- **Onde:** `Jenkinsfile:33` (`WORKER_COUNT=8`) consumido em `cluster.ts:25-27`
- **Problema:** se a droplet/host tem 4 vCPUs, 8 workers competem pelo mesmo CPU → context switching mata latencia. Se tem 16, voce subutiliza. Fixed value e ruim quando voce escala host.
- **Fix:** remover `WORKER_COUNT` do .env. `cluster.ts:27` ja faz fallback `os.cpus().length`. Ou setar via `docker run -e WORKER_COUNT=$(nproc)` no Jenkins deploy.

### [HIGH] Sem graceful shutdown no master
- **Onde:** `cluster.ts:24-39`
- **Problema:** `cluster.on('exit', ... fork())` reinicia worker individual, OK. Mas master nao tem handler pra SIGTERM/SIGINT. Combinado com PID 1 = `sh` (Dockerfile finding), deploy = mata workers no meio de requests.
- **Fix (cluster.ts):**
  ```ts
  if (cluster.isPrimary) {
      // ... fork loop ...
      const shutdown = () => {
          console.log('Master received shutdown signal');
          for (const id in cluster.workers) cluster.workers[id]?.kill('SIGTERM');
          setTimeout(() => process.exit(0), 10000);  // hard timeout
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
  }
  ```
  E no worker, drainar conexoes (Express `server.close()`) antes de exit.

### [MED] Crash loop sem proteca
- **Onde:** `cluster.ts:35-39`
- **Problema:** `cluster.on('exit', ...fork())` **incondicional**. Se worker crashar em loop (config errada, dep faltando), fica forking eternamente, queimando CPU + log spam.
- **Fix:** circuit breaker:
  ```ts
  let crashCount = 0;
  let crashWindow = Date.now();
  cluster.on('exit', () => {
      if (Date.now() - crashWindow > 60000) { crashCount = 0; crashWindow = Date.now(); }
      crashCount++;
      if (crashCount > 10) { console.error('Crash loop detected'); process.exit(1); }
      cluster.fork();
  });
  ```

### [MED] IPC overhead nao avaliado
- **Problema:** Node cluster usa IPC (Unix socket) pro round-robin. Em servico HTTP-only puro, considerar usar SO_REUSEPORT (workers fazem `listen` direto, kernel distribui). Menor overhead, mas requer reescrever cluster setup.
- **Acao:** medir antes de mudar. Em muitos casos o ganho e <5%.

---

## CI/CD (Jenkinsfile)

### [BLOCKER] Credenciais Mongo HARDCODED no Jenkinsfile
- **Onde:** `Jenkinsfile:30` — `MONGODB_URL=mongodb+srv://joinads:b019C7Fyc4P35hg8@private-mongodb-2a2b6805.mongo.ondigitalocean.com/`
- **Problema:** password do Mongo de producao em plaintext no SCM. Qualquer um com acesso ao repo (ou ao Jenkins workspace) tem credencial de DB. **Rotacionar agora.** Combinado com o `COPY .env` no Dockerfile, a credencial tambem vai pra image layer no GHCR.
- **Fix:**
  1. Rotacionar credencial Mongo imediatamente.
  2. Mover pra Jenkins Credentials (`withCredentials([string(credentialsId: 'mongodb-url', variable: 'MONGODB_URL')])`).
  3. Passar via `-e MONGODB_URL=$MONGODB_URL` no `docker run` do stage Deploy.
  4. Deletar `Create Environment File` stage.

### [BLOCKER] Deploy com downtime (`docker stop` + `docker run`)
- **Onde:** `Jenkinsfile:58-65`
- **Problema:** `docker stop ... && docker rm ... && docker run` = blackout de ~5-15s a cada deploy. Para servico latency-critical com alto volume, perde milhares de redirects.
- **Fix (blue-green minimo):**
  1. Run `redirect-new` em porta diferente (ex: 6970).
  2. Aguardar healthcheck OK (`curl http://localhost:6970/health`).
  3. Atualizar nginx upstream (ou via 2-server upstream com `down` flag) e `nginx -s reload`.
  4. `docker stop redirect-old && docker rm redirect-old`.
  5. Renomear `redirect-new` → `redirect`.
- **Alternativa:** Docker Swarm `service update --update-parallelism 1 --update-delay 10s`, ou K8s rolling update. Pelo escopo atual, blue-green via 2 containers + nginx upstream e o caminho de menor friccao.

### [HIGH] Sem Docker BuildKit cache (build do zero a cada commit)
- **Onde:** `Jenkinsfile:48` — `docker buildx build --platform=linux/amd64 --push --tag ghcr.io/caionorder/redirect:latest .`
- **Problema:** sem `--cache-from` / `--cache-to`, builder roda npm install + tsc do zero todo build. ~2-5 min desperdicados.
- **Fix:**
  ```
  docker buildx build \
      --platform=linux/amd64 \
      --cache-from=type=registry,ref=ghcr.io/caionorder/redirect:buildcache \
      --cache-to=type=registry,ref=ghcr.io/caionorder/redirect:buildcache,mode=max \
      --push --tag ghcr.io/caionorder/redirect:latest .
  ```

### [HIGH] Sem container limits no `docker run`
- **Onde:** `Jenkinsfile:63`
- **Problema:** sem `--memory`, `--cpus`, `--pids-limit`, `--ulimit nofile=...`. Container pode estourar memoria do host (8 workers + Redis), competir CPU com outros containers, hit ulimit default de 1024 fds em high-traffic.
- **Fix:**
  ```
  docker run -d --restart=always --name norder-redirect \
      --network joinads -p 6969:3000 \
      --memory=2g --memory-reservation=1g \
      --cpus=4 \
      --ulimit nofile=65535:65535 \
      --pids-limit=512 \
      ghcr.io/caionorder/redirect:latest
  ```

### [MED] `docker login` sem cleanup
- **Onde:** `Jenkinsfile:45`
- **Problema:** token GitHub fica em `~/.docker/config.json` no Jenkins agent. `cleanWs()` (linha 73) limpa workspace, nao home do user.
- **Fix:** adicionar `sh 'docker logout ghcr.io || true'` no `post { always { ... } }`.

### [MED] Nenhuma imagem antiga limpa no servidor
- **Problema:** `docker pull latest` baixa nova layer; imagens antigas acumulam ate encher disco.
- **Fix:** apos deploy bem-sucedido, `docker image prune -af --filter "until=24h"` no servidor (ssh).

### [MED] `StrictHostKeyChecking=no` no SSH
- **Onde:** `Jenkinsfile:59`
- **Problema:** vulneravel a MITM se DNS/rede comprometido. Em deploy interno baixo risco mas anti-pratica.
- **Fix:** pre-popular `~/.ssh/known_hosts` no Jenkins agent, remover `-o StrictHostKeyChecking=no`.

### [LOW] Stages podem paralelizar
- **Problema:** `Check buildx` + `Checkout` + `Create Environment File` sao sequenciais e independentes (depois que checkout terminar, os outros 2 paralelos).
- **Acao:** pequeno ganho, deixar pra depois das mudancas blockers.

---

## .gitignore / .env handling

### [HIGH] `.env` esta no .gitignore mas Jenkinsfile recria com secrets em build
- **Onde:** `.gitignore:16, 92` (ok) + `Jenkinsfile:23-37` (cria com secrets) + `Dockerfile:19` (copia pra imagem)
- **Problema:** o ciclo todo vaza creds:
  1. Jenkins gera `.env` com Mongo password no workspace.
  2. Dockerfile faz `COPY .env .env` → password vai pra image layer.
  3. Imagem e pushada pro `ghcr.io/caionorder/redirect:latest` → password persistida no registry.
- **Fix:** ja coberto nos blockers acima (passar secrets via `docker run -e`, deletar `Create Environment File`, deletar `COPY .env` do Dockerfile).

### [LOW] `.env` duplicado no .gitignore
- **Onde:** `.gitignore:16` e `.gitignore:92` listam `.env`
- **Acao:** deduplicar (cosmetico).

---

## Top 5 quick wins infra

1. **Adicionar upstream keepalive + HTTP/2 no nginx** (`nginx.conf:25, 54`). Maior impacto em TTFB com menor risco. Ganho esperado: -1 a -3ms p50, drop de port exhaustion sob carga. Implementacao: ~10 min.

2. **Remover `error_log debug` → `warn`** (`nginx.conf:6`). IO win imediato, evita disco cheio. Implementacao: 1 linha.

3. **Remover `COPY .env` do Dockerfile + Mongo creds inline do Jenkinsfile** (`Dockerfile:19`, `Jenkinsfile:30`). Vazamento de credencial em prod. **Rotacionar Mongo password ANTES.** Substituir por `docker run -e MONGODB_URL=$MONGOSECRET` via Jenkins Credentials. Critico, mas isolado.

4. **Multi-stage Dockerfile + Node 22 LTS + tini ENTRYPOINT** (Dockerfile inteiro). Resolve PID 1, image size, build cache, signal handling, security (non-root). Implementacao: ~30 min.

5. **Blue-green deploy no Jenkinsfile** (`Jenkinsfile:54-68`). Elimina downtime de 5-15s por deploy. Pode comecar simples: 2 containers em portas 6969/6970 + nginx upstream switching. Implementacao: ~2h pra primeira versao.

---

## Riscos / nao recomendados sem benchmark

- **SO_REUSEPORT em vez de cluster IPC** — ganho tipico <5% em servico HTTP-puro. Reescrita do bootstrap nao vale sem profile mostrando IPC como gargalo.
- **`gzip` totalmente desligado** — embora seja overhead pra redirects 301, se houver enpoints retornando HTML/JSON (`/health`, errors), gzip ainda ajuda. Manter `gzip on` mas subir `gzip_min_length` pra 1024.
- **Migrar pra K8s pra resolver scaling** — overhead operacional grande pra um servico de 1 imagem. Docker Swarm ou simplesmente 2-3 containers + nginx upstream cobre 90% dos casos sem complexidade. Adiar K8s ate ter >3 servicos com necessidade de orquestracao.
- **`access_log off`** — pode ser tentador mas voce perde rastreabilidade pra debug + analytics. Preferir `buffer=64k flush=5s`.
- **Redis cluster mode** — antes de pensar em sharding/cluster, primeiro tirar Redis do container do app. Single-node Redis aguenta 100k+ ops/sec, dificilmente sera gargalo antes de outras coisas.
- **Mover Jenkins pra GitHub Actions** — fora de escopo deste review, mas avaliar se Jenkins on-prem ainda compensa custo de manutencao.
- **HTTP/3 (QUIC)** — antes de HTTP/3, garantir HTTP/2 funcionando + benchmark. Suporte client variavel, ganhos marginais em redirects.
