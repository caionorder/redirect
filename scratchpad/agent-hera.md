# Hera — Code Performance Review (redirect)

Escopo: TypeScript em `src/`. Foco: TTFB do hot path (`/`, `/db`, `/:slug`).
Modo: read-only. Findings com severidade [BLOCKER|HIGH|MED|LOW].

---

## Hot path (redirect-controller)

### BLOCKER — Controller duplicado e cron duplicado por worker
- `src/app.ts:97` cria `new RedirectController(db)` (instância A).
- `src/app.ts:106` monta `createRedirectRouter(db)` que em `src/routes/redirect-route.ts:7` cria **outra** `new RedirectController(db)` (instância B).
- Cada instância:
  - tem caches **separados** (`bestLinksMapCaches`, `validPostsCache`, `rulesCache`, `inAppRulesCache`) → cache hit rate efetivo cai pela metade.
  - chama `initializeScheduledProcess()` no construtor (`redirect-controller.ts:117-121`). Em worker 1, isso dispara **2 crons em paralelo + 2 `executeAllGroups()` no startup** (chamadas WP-VALIDATE e pageview duplicadas).
  - chama `RedirectClickRepository.createIndex()` 2x no boot.
- Recomendação: `RedirectController` deve ser singleton. Instanciar 1x em `app.ts` e injetar em `createRedirectRouter(controller)`.

### BLOCKER — `morgan` síncrono no hot path
- `src/app.ts:38` `app.use(morgan('[UTM REQUEST] :method :url'))` — formato custom, mas `morgan` escreve em `process.stdout` por request. Em alta RPS isso vira backpressure (write síncrono em pipe Docker stdout).
- Recomendação: desligar morgan em prod no caminho de redirect (montar só em `/api`), ou trocar por pino com transport async. Para um redirect service, idealmente: nada de log por request.

### HIGH — `console.log` em todo redirect path
- `redirect-controller.ts:1013, 1021, 1024, 1044, 1048, 1098, 1120, 1145, 1150, 1252, 1256, 1281, 1286` — múltiplos `console.log` por request (RULE/INAPP/IFRAME/RANK/CLICK).
- `console.log` é síncrono em TTYs e bufferizado em pipes; sob carga alta, drena event loop. O log de linha 1024 ainda faz `JSON.stringify(inAppRules.map(...))` toda vez que há `utm_campaign` na request, mesmo sem match → alocação grande no hot path.
- Recomendação: substituir por pino em level `info`+ com sampling, ou remover. Pelo menos remover o `[DEBUG INAPP]` (1021) e o `JSON.stringify` (1024).

### HIGH — `compression` aplicado em redirects
- `src/app.ts:42-45` aplica `compression({ level:6, threshold:1024 })` globalmente. Resposta `res.redirect()` tem body curto (<1KB), threshold protege do gzip propriamente dito, mas a middleware ainda intercepta `res.write/end` e instala listeners — overhead inútil em **toda** request 302.
- Recomendação: montar `compression` apenas em `/api` (rotas que retornam JSON). Hot path nem deveria entrar nessa middleware.

### HIGH — CORS/Helmet aplicados no hot path
- `src/app.ts:21-31, 48-53` — `helmet({ csp })` e `cors({ origin:'*', credentials:true })` montados antes do redirect handler. Em 302 o header CSP é inútil (browser não renderiza). CORS preflight também não se aplica a um redirect navigational. Cada request paga setHeader e branch lookup à toa.
- Recomendação: mover `helmet` e `cors` para `app.use('/api', ...)`. Hot path mantém só `trust proxy`, `disable etag`.

### HIGH — `incrementClick` per-request → 2 round-trips Mongo por redirect
- `redirect-controller.ts:1144` e `1148` (e 1280, 1284) fazem `findOneAndUpdate` upsert no Mongo a cada redirect (1x para `linkId`, 1x para `broad`). Fire-and-forget mascara latência percebida pelo cliente, mas pressiona Mongo e o pool de connections.
- Em workload alto isso vira gargalo (lock collection-level, write concern). Também **reseta** o write concern por chamada — não há batching.
- Recomendação: contador em Redis (`HINCRBY clicks:counters $linkId 1`), flusher cron 30s/60s consolidando para Mongo via `bulkWrite`. Reduz writes Mongo de 2×RPS para 2 a cada 30s.

### HIGH — Regex global em `getClickCountsBySuffixes`
- `redirect-click-repository.ts:236-296` constrói `$or` de regex `_${suffix}$` por link_id. Sem índice ajudando (regex non-anchored from start = collection scan). Para 50 sufixos × N docs = full scan + reduce/split em pipeline.
- Não é hot path direto (chamado em `/api/rank`), mas se o painel chamar com frequência, dói.
- Recomendação: gravar o sufixo `domain_postId` como campo dedicado em `redirects_clicks` no momento do increment. Aí é `$match` com `$in` indexado. (Cross com Poseidon — owner do schema/index.)

### MED — `invertedLangDomains` recriado por request
- `redirect-controller.ts:1102` array literal `['appmobile4u.com', ...]` é alocado a cada `redirect()`.
- Recomendação: declarar como `private static readonly INVERTED_LANG_DOMAINS = new Set([...])`. Lookup vira O(1) (`.has(url.hostname)`) e zero alocação por request.

### MED — `new URL(redirectUrl)` mesmo quando não vai usar
- `redirect-controller.ts:1103` faz parse completo de URL, mas `url` só é necessário para domínios em `invertedLangDomains` (linha 1107).
- Recomendação: checar `INVERTED_LANG_DOMAINS.has(<hostname extraído por substring>)` ANTES e só instanciar `URL` se entrar na branch.

### MED — `URLSearchParams` + loop por request
- `redirect-controller.ts:1123-1128, 1259-1264` — para cada redirect, itera `Object.entries(req.query)` e popula `URLSearchParams`. Express já parseia querystring; bastaria pegar `req.url.split('?')[1]` (ou guardar `originalUrl`) e concatenar, evitando double-parse.
- Pequena otimização, mas em alto RPS soma.

### MED — `redis.set('recent:<ip>', ..., 'EX', 5)` é dead code
- `redirect-controller.ts:1156` (e 1292) escreve em Redis mas a chave **nunca é lida** em lugar nenhum do código. Comentário diz "anti-duplicação" mas não há `get` correspondente.
- Recomendação: remover. Reduz 1 write Redis por redirect.

### LOW — `req.path.includes('favicon') || req.url.includes('favicon')`
- `redirect-controller.ts:997, 1172` — duplica check. `req.path` e `req.url` divergem só em querystring; `favicon` em querystring é improvável.
- Recomendação: simplificar para `if (req.path.endsWith('/favicon.ico')) ...`.

### LOW — `getVisitorKey` aloca `Date` por request
- `redirect-controller.ts:580` `new Date().getHours()` por chamada. Ok, mas em hot path: cachear hora atual num ticker (refresh cada minuto) elimina alocação.

### LOW — `cluster.isWorker || cluster.worker?.id === 1`
- `redirect-controller.ts:117` — lógica está invertida em intent: `!cluster.isWorker` em modo single-process é true, então cron roda. Em cluster, só worker 1 roda. OK funcionalmente mas combinado com BLOCKER de controller duplicado, vira 2 crons no worker 1.

---

## Middleware / app.ts

### HIGH — Init pesado no startup
- `src/app.ts:113-122` itera slugs e registra rota estática para cada um. OK.
- `src/app.ts:128-152` catch-all `/:param` faz `domainGroupService.getActiveSlugs()` por request. `getActiveSlugs()` em `domain-group-service.ts:117-120` retorna `Array.from(this.cache.keys())` — **aloca novo array a cada chamada**. Em hot path com catch-all, isso é alocação em GC quente.
- Recomendação: cachear `slugsArray` no service e invalidar quando `refreshCache()` rodar. Memoizar.

### HIGH — Catch-all assíncrono mesmo com cache em memória
- `src/app.ts:128-139` chama `getActiveSlugs().then(...)` — promise overhead por request. `ensureCache()` é async-on-first-call, depois sync, mas continua retornando Promise. Cada request paga microtask scheduling.
- Recomendação: expor um `getActiveSlugsSync()` que retorna o array cacheado (já carregado no startup). Catch-all passa a ser síncrono.

### MED — `app.use(express.json({ limit: '10mb' }))` e `urlencoded` global
- `src/app.ts:56-57` montados antes das rotas de redirect (que não têm body). `express.json` no-op para GET por content-type, mas a middleware ainda entra na chain.
- Recomendação: montar só em `/api`.

### LOW — `app.set('etag', false)` ✓ correto para redirect
- `src/app.ts:34` — bom. Etag é caro e inútil para 302.

### LOW — `helmet` CSP com `*` em frameSrc
- `src/app.ts:25` `frameSrc: ["'self'", "*"]` — security smell, mas é pra rota iframe (in-app). Não-perf, segue para Aegis.

---

## Services

### MED — `superfilter-service.ts` — sort triplo
- `superfilter-service.ts:55-59` ordena `build` por revenue desc.
- `superfilter-service.ts:73-77` ordena `processedData` por revenue desc.
- `builder-service.ts:196-200` já adiciona `$sort` no pipeline Mongo.
- Total: 3 sorts. Para N=50 items é negligenciável; para grandes payloads do `/api/process` cresce. Não é hot path.
- Recomendação: remover sort 55-59 (vem ordenado de Mongo).

### MED — `builder-service.ts:203` — `JSON.stringify(pipeline, null, 2)` por execução
- Não é hot path (cron 15 min), mas em request manual `/api/process` roda toda vez.
- Recomendação: remover ou colocar atrás de `if (process.env.DEBUG)`.

### MED — `process-service.ts:79-114` — múltiplos passes sobre `group`
- `sumField` chamado 7x sobre o mesmo array → 7 `Array.reduce` separados. Para grupos pequenos OK. Para datasets grandes (raros aqui) pode ser unificado em 1 pass.
- LOW para o uso atual (cron 15 min, ~50-200 itens).

### LOW — `pageview-service.ts:67-86` — batches sequenciais com `await`
- Throttle de 3 concorrentes em loop sequencial é correto. Worst case 50 itens × 3s timeout = ~17 batches. ~17s por cron. Aceitável (cron a cada 15 min).
- Recomendação: trocar por `p-limit` com pool persistente (overlap entre batches melhora wall-time).

### MED — `domain-group-service.ts:117, 125` — alocação por chamada
- `getActiveSlugs()` e `getAllDomains()` retornam novo array via `Array.from`. No catch-all, chamado per request.
- Recomendação: memoizar array cacheado, invalidar em `refreshCache()`.

---

## Repositories

### HIGH — `redirect-click-repository.ts:209-227` — `incrementMultipleClicks` é N+1
- Loop com `await collection.updateOne(...)` sequencial. Para N linkIds, N round-trips.
- Recomendação: `collection.bulkWrite([{ updateOne: ... }, ...], { ordered:false })`. 1 round-trip.

### HIGH — `redirect-click-repository.ts:236-296` — pipeline pesado
- Já citado em hot path. Resumindo: `$or` de regex sem âncora inicial → collection scan; `$let`/`$reduce`/`$split` por doc → CPU Mongo.
- Recomendação (Poseidon): adicionar campo `suffix` indexado, gravar no momento do increment.

### LOW — `broad-click-repository.ts:18` — `new Date().toISOString().split('T')[0]` por click
- Aloca Date + string split a cada increment. `today` poderia ser cacheado (refresh à meia-noite) por instância — mas com fire-and-forget e várias instâncias, pouco ganho.

### LOW — `redirect-link-repository.ts` — sem `projection`
- `getAllLinks`, `getLinksByDomain` retornam doc completo. Não são hot path. OK.

### LOW — `domain-group-repository.ts:9-18` — `ensureIndexes()` chamado no constructor sem `await`
- Fire-and-forget. Mongo handle dedupe, mas error silencioso. Não-perf.

---

## Outros (cron, config, error-handler)

### MED — `config/redis.ts:3-12` sem `lazyConnect`, sem TLS, sem keepAlive
- `ioredis` default cria conexão imediata. OK para serviço always-on.
- `retryStrategy` 50ms*N até 2s — agressivo no boot, OK em runtime.
- Sem `enableOfflineQueue: false` — durante reconnect comandos enfileiram em memória → memória vaza se Redis ficar fora muito tempo.
- Recomendação: setar `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` para hot path. Falha rápido, evita queue infinita.

### MED — `config/database.ts:3-11` — sem pool config, sem `maxPoolSize`
- `MongoClient.connect(url)` usa defaults (pool 100). Para redirect com cluster N workers, total conexões = N*100. Pode estourar Mongo em cluster grande.
- Recomendação: setar `maxPoolSize` explicitamente. Para cluster `os.cpus()`, considerar `maxPoolSize: 20` por worker.

### LOW — `config/cluster.ts:1-43` — fork básico, sem graceful shutdown
- OK para perf. Não-perf: `cluster.fork()` no `exit` sem backoff pode loop em crash. Não é Hera.

### MED — `middleware/error-handler.ts:10-13` — `console.error` com stack completo
- Não é hot path em sucesso, mas se um path quente começar a errar, stack trace é caro.
- Recomendação: trocar por logger estruturado (pino), ou usar `err.message` em prod sem stack.

### HIGH — Cron e requests competem no mesmo worker
- `redirect-controller.ts:117-121` — cron só roda no worker 1 (correto). Mas worker 1 também recebe requests do redirect (load balancer Node nivela). Durante a execução do cron (`fetchAllValidPosts` em paralelo, pageviews em batches), worker 1 fica com event loop ocupado por seg/dezenas-de-seg → TTFB de redirects no worker 1 sobe.
- Recomendação: rodar cron em **processo dedicado** (cluster workerType=cron, sem listen), ou em outro container. Worker que serve redirect não deve fazer cron.

---

## Top 5 quick wins (impacto/esforço)

1. **Remover instanciação duplicada de `RedirectController`** — editar `routes/redirect-route.ts` para receber `controller` injetado em vez de criar dentro. **1 linha.** Resolve cron duplo, dobra cache hit rate, remove 50% das chamadas WP-VALIDATE.
2. **Mover `helmet`/`cors`/`compression`/`json`/`urlencoded` para `app.use('/api', ...)`** — hot path passa a ter só `trust proxy` + handler. **5 linhas.** Reduz overhead de middleware por redirect.
3. **Remover `morgan` no hot path + remover `console.log` mais frequentes (`[DEBUG INAPP]` linha 1021/1024, `[CLICK RECORDED ...]` linhas 1145/1150/1281/1286)**. **~10 linhas.** Reduz I/O sync no event loop.
4. **`invertedLangDomains` virar `static readonly Set` + skip `new URL()` quando hostname não está no set.** **5 linhas.** Reduz alocação por request.
5. **Memoizar `getActiveSlugs()` no `DomainGroupService` (cachear array, invalidar em `refreshCache`).** Tornar `getActiveSlugs()` sync. Catch-all em `app.ts` deixa de pagar microtask. **10 linhas.** Hot path puramente síncrono no fast-path.

Bônus 6 (esforço maior, alto impacto): batching de `incrementClick` via Redis HINCRBY + flusher cron → corta 2 writes Mongo por redirect.

---

## Riscos para validar com benchmark

- Confirmar que **remover `morgan`** corta TTFB p99 — bench com `wrk -t8 -c500 -d30s http://localhost:3000/?utm_source=x`.
- Antes/depois de **deduplicar controller** olhar logs `[CRON]` — esperado: aparecer só 1 vez por boot do worker 1, não 2.
- Medir taxa de hit do `bestLinksMapCaches` antes/depois (instrumentar contador). Esperado: hit rate >95% após dedup.
- Pool Mongo: ver `db.serverStatus().connections` antes/depois do `maxPoolSize` explícito. Não deve degradar throughput.
- Validar que `enableOfflineQueue: false` no Redis não quebra nada em deploy (Redis restart) — pode ser preciso adicionar guard `try/catch` em chamadas no hot path.
- `compression` removido do redirect: confirmar que `/api/*` continua respondendo gzip (essas rotas devolvem JSON grande em `/api/rank-by-domain`).
