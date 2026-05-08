# Athena — Implementacao Fase 1 (itens 1.4, 1.5, 1.6, 1.7, 1.8, 1.14)

Modo: aplicar mudancas. Build TS validado com `npx tsc --noEmit` (EXIT=0).

---

## Arquivos modificados

### 1. `src/routes/redirect-route.ts` (rewrite)
- Antes: `createRedirectRouter(db?: Db)` instanciava `new RedirectController(db)` internamente (2a instancia por worker).
- Depois: `createRedirectRouter(controller: RedirectController)` recebe injetado. Removido import de `Db`.
- **Item 1.4 — singleton.** Junto com mudanca correspondente em `src/app.ts`.

### 2. `src/app.ts` (rewrite)
Mudancas combinadas (1.4, 1.5, 1.6):
- **1.4**: `RedirectController` instanciado UMA vez (`const redirectController = new RedirectController(db);`) e passado a `createRedirectRouter(redirectController)`. Antes era 2x por worker.
- **1.5**: `helmet`, `cors`, `compression`, `express.json`, `express.urlencoded` movidos de `app.use(...)` global para um `apiRouter = Router()` dedicado, montado em `app.use('/api', apiRouter)`. `domain-group-route` e `redirect-route` agora sao sub-routers do `apiRouter`.
- Hot path (`/`, `/db`, `/:slug`, `/:slug/:campaignId`, catch-all) NAO passa por nenhum desses 5 middlewares.
- Mantidos globais: `trust proxy`, `disable x-powered-by`, `etag false`, healthcheck (em `app.use(createHealthRouter(db))`), error handler.
- **1.6 (parte 1)**: `morgan` removido do `app.use` global; agora montado APENAS no `apiRouter` E condicionado a `NODE_ENV !== 'production' && NODE_ENV !== 'test'`. Em prod, morgan nao roda em lugar nenhum.

### 3. `src/controllers/redirect-controller.ts`
Mudancas (1.6 parte 2, 1.7, 1.8):

**Adicoes na classe (~linha 100):**
- `private static readonly DEBUG_REDIRECT = process.env.DEBUG_REDIRECT === '1';` — flag avaliada uma vez no carregamento do modulo.
- `private static readonly INVERTED_LANG_DOMAINS = new Set<string>([...])` — Set estatico (substitui o array recriado por request).

**Hot path `redirect()` (handler de `/`):**
- Linha 1021 (antes): `console.log('[DEBUG INAPP] campaignId=...')` — REMOVIDO.
- Linha 1024 (antes): `console.log('[DEBUG INAPP] rules count=... JSON.stringify(...)')` — REMOVIDO. Eliminada alocacao de JSON.stringify no fast path.
- Linhas 1101-1116 (antes): `invertedLangDomains` array literal + `new URL(redirectUrl)` incondicional + `.some(d => url.hostname === d)`. AGORA: extracao de hostname via `indexOf`/`slice` (zero alocacao no fast path), `INVERTED_LANG_DOMAINS.has(hostname)` O(1). `new URL(redirectUrl)` so executa quando hostname pertence ao set (~5 dominios) — fast path para o resto pula parsing completo de URL.
- Linha 1120 (antes): `console.log('[${logType}]${langInfo}...')` per request — agora dentro de `if (RedirectController.DEBUG_REDIRECT)`, que vira false em prod (cost = 1 boolean check).
- Linha 1145 (antes): `.then(result => console.log('[CLICK RECORDED]...'))` — REMOVIDO. Mantido `.catch(() => {})`.
- Linha 1150 (antes): `.then(... '[CLICK RECORDED BROAD]'...)` — REMOVIDO.
- Linha 1156 (antes): `this.redisClient.set('recent:'+clientIp, finalRedirectUrl, 'EX', 5)` — REMOVIDO (item 1.8). Confirmado via grep que `recent:` nao e LIDO em nenhum lugar do codigo. Bloco `// Cache anti-duplicacao` removido completamente.

**Hot path `redirectByGroup()` (handler de `/db`, `/:slug`):**
- Linha 1256 (antes): `console.log('[${logType}] ${domain} -> ...')` per request — agora dentro de `if (RedirectController.DEBUG_REDIRECT)`.
- Linha 1281 (antes): `.then(... '[CLICK RECORDED ${slug}]'...)` — REMOVIDO.
- Linha 1286 (antes): `.then(... '[CLICK RECORDED BROAD ${slug}]'...)` — REMOVIDO.
- Linha 1292 (antes): `redis.set('recent:'+clientIp, ...)` — REMOVIDO.

**Logs preservados** (nao sao hot path, ou sao branches raras):
- Todos `[CRON-...]`, `[WP-VALIDATE]`, `[RULE CREATED]`, `[INAPP RULE CREATED]` etc. (init/cron).
- `[RULE REDIRECT]` (linha 1025) — fires apenas se request matcha rule (raro).
- `[INAPP REDIRECT]`, `[IFRAME]` (1054, 1058, 1216, 1219) — fires apenas em match in-app (raro).
- `[DEBUG] ranking global está VAZIO` (1108, 1264) — fires so quando ranking nao foi populado (estado anormal).
- Todos `console.error` (paths de erro).

### 4. `src/repositories/redirect-click-repository.ts`
- **1.14**: `incrementMultipleClicks(linkIds)` reescrito.
  - Antes: loop `for ... of` com `await this.collection.updateOne(...)` por linkId → N round-trips.
  - Depois: `this.collection.bulkWrite(operations, { ordered: false })` → 1 round-trip. Cada operacao e `{ updateOne: { filter, update: {$inc, $setOnInsert}, upsert: true } }`. Retorno: `(modifiedCount + upsertedCount)` da resposta agregada do bulkWrite.
- Adicionado import `AnyBulkWriteOperation` de `mongodb` para tipagem do array de operacoes.
- Assinatura externa preservada: `incrementMultipleClicks(linkIds: string[]): Promise<number>`.

---

## Findings adicionais (nao corrigidos — fora do escopo desta task)

1. **`clientIp` nao e mais usado em `redirectByGroup`** — apos remocao do `redis.set('recent:...')` ele ainda e referenciado em `getBestRpsLink(clientIp, ...)` na branch `bestRpsMode`. Em `redirect()`, idem. Sem warning de unused-var.
2. **`getBestRpsLink` continua usando clientIp** — e onde a logica de visitante por hora vive. Mantido inalterado.
3. **iframe HTML response nao tem mais helmet** — ao mover helmet pra `/api`, o `res.send(this.generateIframeHtml(finalUrl))` (em `redirect()` e `redirectByGroup()`) nao seta mais CSP. Ver Risk Flag #1 abaixo.

---

## Risk Flags / Validacao manual necessaria

### #1 — Helmet/CSP removido do hot path (incluindo iframe HTML)
- Antes: helmet global aplicava CSP a TODA response (302s e iframe HTML).
- Depois: helmet so em `/api/*`. As 302s perdem 6 headers de seguranca (irrelevante para 302 navegacional). O iframe HTML perde CSP — browser usa default permissivo (aceita iframes de qualquer origem, mesma intencao do `frameSrc: ['self','*']` original).
- **Validar manualmente**: testar fluxo in-app de iframe (Meta crawler -> iframe page -> destino) ainda funciona. Se quebrar, opcoes:
  - Adicionar `res.setHeader('Content-Security-Policy', "default-src 'self'; frame-src 'self' *; ...")` inline antes de cada `res.send(this.generateIframeHtml(...))`.
  - Ou mover `helmet({ contentSecurityPolicy: ... })` para um middleware aplicado especificamente nas rotas de redirect (mas ai gasta o overhead em 302s tambem).

### #2 — Singleton consolidacao de cache
- Apos 1.4, todas as requests passam pela mesma instancia de `RedirectController`. Caches em memoria (`bestLinksMapCaches`, `validPostsCache`, `rulesCache`, `inAppRulesCache`) deixam de ser fragmentados.
- **Validar logs**: apos boot do worker 1, deve aparecer `[CRON] Inicializando agendamento` UMA vez (antes apareceria 2x). Mesma coisa para `[CRON] Cache inicial de todos os grupos populado`. Hit rate dos caches subir.

### #3 — `incrementMultipleClicks` retorna count diferente em casos raros
- Comportamento antigo: contava sucessos (`modifiedCount === 1 || upsertedCount === 1`) por linkId.
- Comportamento novo: agrega `result.modifiedCount + result.upsertedCount` da resposta do bulkWrite.
- Em condicoes normais sao equivalentes. Edge: se um update nao alterar o doc (raro com `$inc`), o numerinho retornado pode mudar. Caller atual (validar via grep `incrementMultipleClicks` nao foi feito ainda — caller pode ser logging only).

### #4 — `apiRouter` ordem dos sub-routers
- `apiRouter.use('/domain-groups', createDomainGroupRouter(...))` antes de `apiRouter.use('/', createRedirectRouter(redirectController))`.
- `createRedirectRouter` define rotas como `/redirect`, `/process`, `/stats`, `/rank`, etc. (todas com nomes especificos), nenhuma colide com `/domain-groups`. Seguro.

### #5 — `morgan` agora so em dev
- Em prod (`NODE_ENV=production`), nao ha mais log estruturado per-request. Se ops dependia disso para troubleshooting, considerar pino com sampling no proximo sprint (Fase 2/3).

---

## Comando de validacao

```bash
cd /Users/caionorder/Dev/redirect && npx tsc --noEmit
```
Resultado: EXIT=0 (build limpa, zero erros).

---

## Arquivos finais (resumo)

| Arquivo | Linhas (antes -> depois) | Mudanca |
|---------|-------------------------|---------|
| `src/routes/redirect-route.ts` | 76 -> 73 | Recebe controller injetado |
| `src/app.ts` | 182 -> 175 | Middlewares pesados em `/api` router; controller singleton |
| `src/controllers/redirect-controller.ts` | hot-path -10 console.log -2 redis writes; +Set estatico; URL parse condicional | 1.6 + 1.7 + 1.8 |
| `src/repositories/redirect-click-repository.ts` | `incrementMultipleClicks` N->1 RTT | 1.14 |

---

## Proximos passos (quem implementa)

- Itens 1.1, 1.2, 1.3 (nginx) → Hephaestus.
- Itens 1.9, 1.10, 1.11 (migrations Mongo) → Poseidon.
- Itens 1.12, 1.13 (config Mongo + Redis) → Hephaestus ou outro Node engineer.
- Code review pre-merge → Hera.
- Audit das mudancas de seguranca (CSP/helmet) → Aegis.
