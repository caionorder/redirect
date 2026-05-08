# Hera — Code Review (Fase 1 perf impl)

## Verdict
**REQUEST CHANGES** — escopo das mudancas esta correto, `tsc` passa, 95% pronto. Mas existe **1 HIGH** (regressao de tolerancia a falha de Redis) que precisa ser endereçada antes do commit. Sem essa correcao, um blip de Redis em prod faz `/db` e `/<slug>` responderem **HTTP 500** e `/` cair pra fallback hardcoded — pior que o estado anterior (que mascarava com offline queue).

Apos fix do HIGH-1, **APPROVE**.

---

## Findings — BLOCKER
Nenhum.

---

## Findings — HIGH

### H-1 — Redis hot-path sem try/catch + `enableOfflineQueue:false` = 500 sob blip de Redis
`src/config/redis.ts:9` agora seta `enableOfflineQueue:false`. Com isso, qualquer chamada Redis durante reconnect/falha lanca `Stream isn't writeable` em vez de enfileirar.

Quatro call-sites no controller fazem `await this.redisClient.X` SEM try/catch local:

- `src/controllers/redirect-controller.ts:600-609` `getGlobalVisitIndex` — `incr` + `expire`. **HOT PATH**: chamada em `/` (l1092) e `/<slug>` (l1249) no modo default (bestRpsMode=false). Catch externo:
  - `redirect()` (l1172-1175) → fallback `https://useuapp.com/random` (perde ranking, manda tudo pro mesmo URL).
  - `redirectByGroup()` (l1301-1304) → **HTTP 500** ao usuario. **REGRESSAO REAL**.
- `src/controllers/redirect-controller.ts:615-625` `addVisitedDomain` — `sadd` + `ttl` + `expire`. Nao parece ter caller ativo no momento (grep nao acha), mas existe e fica como armadilha.
- `src/controllers/redirect-controller.ts:759-764` `saveRules` — admin POST. Sem catch local; o caller (l818, l842) tem catch externo, entao retorna 500 ao admin (aceitavel mas degrada UX).
- `src/controllers/redirect-controller.ts:924-929` `saveInAppRules` — idem.

**Fix (Athena):** envolver cada uma dessas chamadas em try/catch, retornando default benign:
- `getGlobalVisitIndex` → `return 0` no catch (cycle ainda funciona).
- `addVisitedDomain` → `return` silencioso.
- `saveRules` / `saveInAppRules` → log + `throw` controlado (ou apenas log e ignorar — admin re-tenta).

Alternativa mais segura: manter `enableOfflineQueue:true` (default) ate todos os call-sites estarem hardenados. Mas o plano explicita 1.13 com `enableOfflineQueue:false` + revisao de call sites — entao a opcao correta e hardener os call sites agora.

---

## Findings — MED

### M-1 — Hostname extraction case-sensitive (regressao sutil)
`src/controllers/redirect-controller.ts:1113-1122`. Codigo anterior usava `url.hostname` (sempre lowercase via WHATWG URL). Fast-path por substring nao normaliza case. URL com host `APPMOBILE4U.COM` deixa de bater no Set.

**Fix (Athena):** `hostname = hostname.toLowerCase();` apos extracao (linha 1120).

Em pratica, links cadastrados sao lowercase — improvavel ter live impact. Mas e regressao funcional.

### M-2 — Iframe HTML servido sem helmet/CSP/X-Frame-Options
`src/controllers/redirect-controller.ts:1059` `res.send(this.generateIframeHtml(finalUrl))`. As rotas `/`, `/db`, `/<slug>` foram movidas para fora do `apiRouter` (sem helmet). Iframe HTML sai sem CSP nem X-Frame-Options. Anteriormente o iframe estava protegido (helmet global aplicava `frameAncestors` etc.).

**Fix:** Aegis deve revisar (ja flagged em Athena impl report). Possiveis caminhos:
- Aplicar helmet inline no `res.send(this.generateIframeHtml(...))` antes de mandar.
- Ou rebatizar `generateIframeHtml` para incluir `<meta http-equiv="Content-Security-Policy" ...>` no HTML.

Pertence a Aegis decidir severidade real.

### M-3 — Migration 001 indice `domain_url_unique` cria NAO-UNIQUE quando ha duplicatas
`migrations/001-redirects-links-indexes.ts:26-36`. Nome do indice fica `domain_url_unique` mesmo quando ele e NAO unique. Confunde ops. Re-rodar apos fix de dupes nao upgrade automaticamente — exige drop manual (README cobre, mas e pegadinha).

**Fix (Poseidon):** ou
- Falhar a migration quando dupes detectadas (`process.exit(1)` em vez de fallback silencioso), forcando operator a limpar antes; **ou**
- Criar como `domain_url` (nome sem "unique") na branch nao-unique e como `domain_url_unique` so quando consegue.

### M-4 — `incrementMultipleClicks` semantica do retorno mudou em duplicatas
`src/repositories/redirect-click-repository.ts:222`. `result.modifiedCount + result.upsertedCount` e funcionalmente equivalente ao codigo anterior **quando `linkIds` e unico**. Se `linkIds` tiver duplicatas, com `ordered:false` os dois updates da mesma key entram juntos — `modifiedCount` pode nao bater 1:1. Provavelmente nao chega caso real de duplicata, mas vale documentar a precondicao.

**Fix (Athena):** comentario JSDoc dizendo "assume linkIds unicos" OU `Array.from(new Set(linkIds))` no inicio.

---

## Findings — LOW / nits

### L-1 — Console.log residuais em hot path (nao gated por `DEBUG_REDIRECT`)
- `src/controllers/redirect-controller.ts:1025` `[RULE REDIRECT]` — fires em cada match de rule.
- `src/controllers/redirect-controller.ts:1054, 1058` `[INAPP REDIRECT]` / `[IFRAME]` — em cada match de campanha inapp.
- `src/controllers/redirect-controller.ts:1108` `[DEBUG] ranking global está VAZIO` — em cada redirect quando ranking vazio (cenario degradado, mas spamma log).

Plano cobriu apenas os removidos especificos. Esses escapam. Considerar gating.

### L-2 — Morgan agora desligado em production
`src/app.ts:91-93`: `if (NODE_ENV !== 'test' && NODE_ENV !== 'production')`. Antes era so `!== 'test'` — entao prod tinha morgan no /api. Mudanca intencional? Confirmar com operador. Provavel sim (plano queria zerar logging sync no path quente).

### L-3 — `DEBUG_REDIRECT` avaliado uma unica vez no module init
`src/controllers/redirect-controller.ts:104`. Static initializer le `process.env.DEBUG_REDIRECT === '1'` no carregamento. Mudar a env var em runtime nao tem efeito. Comportamento esperado e correto pro propósito (zero overhead per-request), mas documentar pra ops.

### L-4 — Hostname extraction edge cases
`src/controllers/redirect-controller.ts:1113-1121`:
- URL com `:port` (ex: `https://appmobile4u.com:443/...`) → hostname inclui `:443`, nao bate no Set. Provavel nao-issue (URLs cadastradas sem porta), mas vale assert.
- URL sem scheme (`appmobile4u.com/path`) → `hostStart=-1`, hostname stays `''`. Set check falso. Sem `new URL()`. `redirectUrl` vai como-veio ao `res.redirect()` que pode tratar como path relativo. Pre-existente / fora do escopo.
- Fragmento `#` antes de `/` → hostname inclui `#frag`. Nao realista pra redirect URL.

### L-5 — `proxy_buffer_size 32k` deixado com `proxy_buffering off`
`nginx.conf:16, 40`. Buffer-size ainda se aplica ao primeiro chunk de headers; nao quebra. NIT.

### L-6 — `RedirectController` private fields candidatos a `readonly`
`src/controllers/redirect-controller.ts:69-89`. Vários campos que so sao escritos no constructor (ex: `superFilterService`, `pageviewService`, `domainGroupService`, `redisClient`) podem virar `readonly`. NIT estilistico, sem impacto runtime.

### L-7 — Migration 003 vs unique existente em broad_clicks
`migrations/003-broad-clicks-date-index.ts` cria `{date:1, broad_id:1}` complementando `{broad_id, date}` unique existente. Ambos OK no Mongo, sem conflito. Confirmado pelo nome distinto (`date_broadId` vs nome do unique antigo). Validado.

---

## Pontos validados (positivos)

- **Singleton controller**: `grep "new RedirectController"` retorna apenas 1 ocorrencia (`src/app.ts:58`). Caches em memoria (`bestLinksMapCaches`, `rulesCache`, `inAppRulesCache`, `validPostsCache`) agora sao realmente compartilhados por todas as rotas. Cron unico.
- **Hot path enxuto**: `app.get('/', ...)` e `app.get('/db', ...)` montados direto em `app`, NAO em `apiRouter`. Helmet/cors/compression/json/morgan nao tocam o redirect.
- **Hot path e estatica**: rotas dinamicas via `domainGroupService.getActiveSlugs()` (l109-115) tambem direto em `app`. Catch-all `/:param` idem (l124-148). Confirmado.
- **`/api` permanece protegido**: helmet + cors + compression + json/urlencoded + morgan(dev) aplicados via `apiRouter` (l64-94).
- **`/health` fora de `/api`** e antes do `if (db)` block (l49) — sempre disponivel, sem middlewares pesados. Correto.
- **`incrementMultipleClicks` bulkWrite**: `ordered:false` correto pra paralelismo, `upsert:true` em cada op, retorno consistente. Tipagem `AnyBulkWriteOperation<IRedirectClick>` correta.
- **Mongo pool**: `maxPoolSize:30` × 8 workers = 240 conns max, dentro do limite Mongo padrao 65535. `appName:'redirect'` ajuda em `db.currentOp()`. Plano respeitado.
- **Redis config**: timeouts e keepalive corretos. `maxRetriesPerRequest:3` evita pendurar worker.
- **Nginx**: `upstream` com `keepalive 64` + `proxy_set_header Connection ""` (correto pra ativar keepalive entre nginx e upstream). `http2` no listen 443. `access_log buffer=64k flush=5s` reduz IO. `error_log warn` (era `debug`). `gzip_min_length 1024`. `proxy_pass http://redirect_backend` (sem trailing slash) preserva `$request_uri` automaticamente — equivalente ao anterior `$request_uri` explicito.
- **Migrations**: idempotentes (createIndex com mesmo nome+key e no-op). Detect-duplicates antes do unique e seguro re-rodar. README claro.
- **Dead Redis write removido**: `grep "recent:"` retorna vazio. Confirmado.
- **`createRedirectRouter` signature change**: unico caller e `src/app.ts:97`. Sem callers externos. Sem regressao.
- **`INVERTED_LANG_DOMAINS` Set**: `static readonly`, lookup O(1). Lookup com fast-path antes de instanciar `new URL()` esta correto — `new URL()` so e chamado quando hostname bate.

---

## Sugestoes para o original implementer

### Athena (TS)
1. **HIGH-1**: envolver os 4 awaits Redis sem try/catch:
   - `getGlobalVisitIndex` (l600-609) → `try { ... } catch { return 0; }`
   - `addVisitedDomain` (l615-625) → `try { ... } catch {}`
   - `saveRules` (l759-764) → `try { ... } catch (err) { console.error(...); throw; }`
   - `saveInAppRules` (l924-929) → idem.
2. **MED-1**: `hostname = hostname.toLowerCase();` apos extracao (l1120).
3. **NIT L-1**: gatear `[RULE REDIRECT]`, `[INAPP REDIRECT]`, `[IFRAME]`, `[DEBUG] ranking global VAZIO` por `RedirectController.DEBUG_REDIRECT`.
4. **NIT M-4**: comentario "assume linkIds unicos" em `incrementMultipleClicks`.

### Poseidon (Mongo migrations)
1. **MED-3**: na migration 001, ou falhar quando dupes detectadas, ou trocar nome do indice fallback de `domain_url_unique` para `domain_url`.

### Hephaestus (Nginx)
- Sem changes solicitadas. Configuracao validada.

### Aegis (security)
- **MED-2**: validar resposta iframe HTML sem helmet — pode precisar inline meta CSP / X-Frame-Options.
