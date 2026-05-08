# Athena — Static Audit (24 endpoints)

Auditoria estatica do `docs/openapi.yaml` (24 paths) contra os handlers em `src/controllers/*` e o roteamento em `src/app.ts` + `src/routes/*`. READ-ONLY.

## Verdict resumido

- **PASS: 16**
- **WARN: 8**
- **FAIL: 0**

Nenhum bug runtime grave. Todos os handlers tem try/catch e SEMPRE produzem resposta. Os WARNs sao todos de discrepancia spec ↔ handler (status codes nao documentados ou content-type incorreto). Os hot-path handlers (`redirect`, `redirectByGroup`) cobrem 100% dos branches (favicon → 204, rule → 302, in-app rule → 302/200, ranking presente → 302, ranking ausente → 302 random, throw → fallback URL ou 500).

---

## Por endpoint

### GET / (hot path)
- **Status: PASS**
- Mounted: `src/app.ts:110` ✓
- Handler: `redirect-controller.ts:1026` `redirect()` ✓
- Params consumidos: `utm_campaign` (1051), `utm_source/utm_medium` defaults (1171-1172), `broad` (1173-1175), `language` (1089) ✓
- Status retornados: 204 (favicon, 1029) ✓, 302 (rule/inapp/ranking/fallback, 1045/1074/1191) ✓, 200 HTML iframe (1078) ✓
- 503 (DB down) listado no spec → coberto pelo fallback em `app.ts:166-170` quando `db` nao conecta ✓
- Branch coverage: todos paths returnam (favicon → return; rule → return; inapp → return; main path → res.redirect; throw → catch redirect 1194)
- Findings: nenhum

### GET /db (hot path)
- **Status: WARN**
- Mounted: `src/app.ts:113` ✓
- Handler: `redirect-controller.ts:1202` `redirectByGroup(req, res, 'db')` ✓
- Params: utm_campaign, utm_source/medium, broad — todos consumidos
- Status: 204 (1205), 302 (1320), 200 iframe (1240), 503 se grupo sem dominios (1211) ✓
- Findings:
  - **WARN**: handler tem `catch` que retorna **500 JSON** em `1323`, mas spec lista apenas 200/204/302/503. Adicionar 500 ao spec OU mudar fallback para reuse do padrao do `redirect()` (redirect para fallback URL).

### GET /db/{campaignId} (hot path)
- **Status: WARN**
- Mounted: `src/app.ts:129` ✓
- Handler: `redirectByGroup` lendo `req.params.campaignId` em 1216 ✓ (usado como utm_campaign para in-app match)
- Findings:
  - **WARN**: spec lista apenas 200/302. Handler tambem retorna **503** (sem dominios, 1211) e **500** (catch, 1323). Spec esta incompleto.

### GET /{slug} (hot path)
- **Status: WARN**
- Mounted: dois caminhos:
  - Static (slugs ativos no startup): `src/app.ts:121` ✓
  - Catch-all (slugs criados pos-startup): `src/app.ts:132-143` ✓
- Handler: `redirectByGroup(req, res, slug)` em ambos casos ✓
- Equivalencia static vs catch-all: ✓ ambas chamam o mesmo `redirectByGroup`. Catch-all faz `getActiveSlugs()` async; em caso de slug nao-ativo OU `param === 'main'`, cai no `redirect()` (grupo main) — comportamento documentado.
- Catch-all em caso de erro do `getActiveSlugs()`: `.catch(() => redirectController.redirect(req, res))` (142) — fallback seguro ✓
- Findings:
  - **WARN**: spec lista 200/302/503. Handler tambem retorna **500** no catch (1323). Adicionar ao spec.

### GET /{slug}/{campaignId} (hot path)
- **Status: WARN**
- Mounted: static `src/app.ts:122` + catch-all `src/app.ts:145-156` ✓
- Handler: `redirectByGroup` lendo `req.params.campaignId` ✓
- Equivalencia: mesma logica do /{slug}, com campaignId injetado via path
- Sutileza: quando slug nao ativo, cai em `redirect()` que tambem le `req.params.campaignId` (1051) — campaignId acaba sendo usado como utm_campaign no grupo main. Comportamento provavelmente intencional, nao documentado explicitamente no spec.
- Findings:
  - **WARN**: spec lista apenas 200/302. Handler retorna 503 (sem dominios) e 500 (catch). Spec incompleto.

### GET /health
- **Status: PASS** — `health-route.ts:10` → `health-controller.ts:15` `checkHealth`. Sempre 200 com `{status, timestamp}` matching `HealthBasic`.

### GET /health/detailed
- **Status: PASS** — `health-controller.ts:25` `checkHealthDetailed`. 200 (healthy) ou 503 (degraded) com shape `{status, timestamp, services{api,database,redis}}` matching `HealthDetailed`.

### GET /health/ready
- **Status: PASS** — `health-controller.ts:66` `checkReadiness`. 200 `{ready:true}` ou 503 `{ready:false}`.

### GET /ping
- **Status: WARN**
- Mounted: handler inline em `health-route.ts:25-27` ✓
- Findings:
  - **WARN**: spec promete `text/plain`, mas `res.status(200).send('pong')` faz Express inferir `text/html` (string → text/html por default no Express). Para bater com spec: trocar para `res.type('text/plain').send('pong')`. Comportamento funcional ok, mas content-type diverge.

### GET /api/domain-groups
- **Status: PASS** — `domain-group-route.ts:10` → `domain-group-controller.ts:14` `list`. 200 `{groups}`, 500 catch. Bate com spec.

### POST /api/domain-groups
- **Status: PASS** — `domain-group-controller.ts:28` `create`. Le `{slug,name,domains}` (30); valida required e regex `^[a-z0-9-]+$` (32-41) → 400; 409 em E11000 (47); 201 `{group}` (44); 500 catch. Bate com spec.

### PUT /api/domain-groups/{slug}
- **Status: PASS** — `domain-group-controller.ts:60` `update`. Le `{slug,name,bestRpsMode}` (63); 400 se nenhum field (65); regex check (70); 404 se nao achado (76); 409 E11000 (84); 200 `{group}` (81); 500 catch. Bate com spec.

### DELETE /api/domain-groups/{slug}
- **Status: PASS** — `domain-group-controller.ts:95` `delete`. 403 se slug==='main' (99); 404 (105); 200 `{message: "Group 'X' deleted"}` (110); 500 catch. Bate com spec.

### POST /api/domain-groups/{slug}/domains
- **Status: PASS** — `domain-group-controller.ts:121` `addDomains`. Valida `Array.isArray && length>0` (126) → 400; 404 (132); 200 `{group}` (137); 500 catch. Bate com spec.

### DELETE /api/domain-groups/{slug}/domains
- **Status: PASS** — `domain-group-controller.ts:148` `removeDomains`. Mesma validacao do POST. 200/400/404/500 corretos.

### GET /api/redirect
- **Status: PASS** — `redirect-route.ts:8` → mesmo handler `redirect()` que `GET /`. Sob `/api/*` recebe middlewares completos (helmet/cors/json/morgan/compression). Codigo identico, comportamento equivalente. Spec lista 200/302; handler retorna ambos + 204 favicon (mas favicon nao bate `/api/redirect` na pratica — dead branch, sem prejuizo). Bate com spec.

### GET /api/process
- **Status: PASS** — `redirect-controller.ts:550` `process`. Le `req.query.slug` (552); com slug → executa um grupo, retorna `{success, message, slug, data: ranking}` (558-563); sem slug → executa todos, retorna `{success, message, data: {slug→ranking}}` (572-576); 500 catch. Bate com spec.

### GET /api/stats
- **Status: PASS** — `redirect-controller.ts:1452` `getStats`. 503 se sem DB (1455); le start/end/domain/network/country (1460-1464); retorna `{gam, clicks, traffic{totalDomains, totalDomainsDb, globalRanking, globalRankingDb}}` (1472-1481). Bate com schema `Stats`.

### GET /api/rank
- **Status: WARN**
- Handler: `redirect-controller.ts:1327` `getRank`
- Le `sort` (default 'clicks') e `limit` (default 100) ✓
- Retorna `{sort, main, db}` matching schema `RankResult` em cada um ✓
- Findings:
  - **WARN**: handler retorna **503** se `redirectClickRepository` ausente (1330) — spec lista apenas 200 e 500. Adicionar 503 ao spec.

### GET /api/rank-by-domain
- **Status: PASS** — `redirect-controller.ts:1408` `getRankByDomain`. Retorna `{main, db}` cada um com `{total_links, domains, by_domain}` (1434-1445). Bate com schema `RankByDomainGroup`. 500 catch.

### GET /api/distinct/{field}
- **Status: PASS** — `redirect-controller.ts:1491` `getDistinctValues`. Le path `field` (1498); valida contra `['domain','network','country','custom_key','custom_value','ad_unit_name']` (1499) — bate exatamente com enum do spec; 400 com `{error, validFields}` (1502); 503 sem DB (1494); 200 `{field, values}` (1512); 500 catch. Bate com spec.

### GET /api/links
- **Status: WARN**
- Handler: `redirect-controller.ts:1522` `getRedirectLinks`. 503/500 ok; 200 com `{links, total, limit, offset}` (1542)
- Findings:
  - **WARN**: quando `domain` esta presente, handler busca via `getLinksByDomain(domain)` (1535) e ignora `limit`/`offset` (consistente com spec), MAS o campo `total` retornado e `countLinks()` GLOBAL (1540), nao a contagem por dominio. Spec nao especifica o que `total` deve retornar quando filtrado por dominio — ambiguo. Recomendar ajustar handler para retornar `links.length` quando filtrado por dominio, OU documentar explicitamente no spec que `total` e sempre o count global.

### GET /api/broad-clicks
- **Status: WARN**
- Handler: `redirect-controller.ts:1390` `getBroadClicks`. Le `start` e `end` (1397-1398) ✓; retorna array direto via `res.json(clicks)` (1401) matching schema `BroadClick[]`
- Findings:
  - **WARN**: quando `broadClickRepository` ausente, handler retorna **500** (1393) — inconsistente com `/api/links`, `/api/stats`, `/api/distinct/{field}`, `/api/rank` que retornam 503 no mesmo cenario. Padronizar para 503 (e adicionar 503 ao spec) ou documentar a diferenca.

### GET /api/rules
- **Status: PASS** — `redirect-controller.ts:799` `listRules`. 200 `{rules}` (802), 500 catch. Bate com spec.

### POST /api/rules
- **Status: PASS** — `redirect-controller.ts:812` `createRule`. Le `{conditions, destination, passQueryParams, description}` (814); valida required (816) → 400; gera id `${Date.now()}_${random hex 6}` (822) — bate com pattern do exemplo do spec (`'1730983412_a7b9c2'`); 201 `{rule}` (835); `passQueryParams !== false` aplica default true (825) — bate com spec; 500 catch.

### DELETE /api/rules/{id}
- **Status: PASS** — `redirect-controller.ts:845` `deleteRule`. 404 se id nao existe (851); 200 `{message: 'Rule deleted'}` (858); 500 catch.

### GET /api/inapp-rules
- **Status: PASS** — `redirect-controller.ts:953` `listInAppRules`. 200 `{rules}`, 500 catch. Bate com spec.

### POST /api/inapp-rules
- **Status: PASS** — `redirect-controller.ts:967` `createInAppRule`. Le `{utm_campaign, destination, passQueryParams, description}` (969); 400 se required ausente (971); 201 `{rule}` (990); shape de `InAppRule` matching spec; 500 catch. (Nota: spec ja documenta o risco XSS conhecido e aceito da injecao de `destination` no template iframe — nao e um regression.)

### DELETE /api/inapp-rules/{id}
- **Status: PASS** — `redirect-controller.ts:1000` `deleteInAppRule`. 404 (1006); 200 `{message: 'In-app rule deleted'}` (1013); 500 catch.

---

## Top issues a resolver (priorizado)

1. **Spec incompleto nos status code dos hot-path /db, /db/{campaignId}, /{slug}, /{slug}/{campaignId}** — `redirectByGroup` retorna **500 JSON** no catch (`redirect-controller.ts:1323`) e **503** quando o grupo nao tem dominios (`redirect-controller.ts:1211`). Ambos faltam no `docs/openapi.yaml` para esses 4 paths. Decisao: adicionar ao spec OU alinhar handler com `redirect()` (que faz `res.redirect('https://useuapp.com/random')` no catch — manteria 302 sempre).

2. **`/api/broad-clicks` retorna 500 quando DB indisponivel — inconsistente com o resto** (`redirect-controller.ts:1393`). Outros endpoints (`/api/links`, `/api/stats`, `/api/distinct/{field}`, `/api/rank`) retornam 503 no mesmo cenario. Padronizar para 503 e atualizar spec.

3. **`/api/rank` retorna 503 sem DB, undocumented** (`redirect-controller.ts:1330`). Adicionar 503 ao spec.

4. **`/ping` content-type divergente** (`health-route.ts:25-27`): `res.send('pong')` retorna `text/html` por inferencia do Express; spec promete `text/plain`. Trivial: `res.type('text/plain').send('pong')`.

5. **`/api/links` campo `total` ambiguo quando filtrado por dominio** (`redirect-controller.ts:1540`). Hoje retorna count global. Decidir e documentar (ou ajustar para `links.length` quando filtrado).

6. **Inconsistencia de comportamento entre `redirect()` e `redirectByGroup()` no catch** — `redirect()` faz `res.redirect(fallbackUrl)` (1194), `redirectByGroup()` faz `res.status(500).json(...)` (1323). Para um servico hot-path navegacional, retornar 500 JSON no browser do usuario e UX ruim. Considerar uniformizar: ambos com fallback `res.redirect(...)` em caso de excecao inesperada.

## Notas finais

- **Roteamento esta solido**: ordem de registro (`/health`, `/openapi.json`, `/redocs`, `/api-docs/*`, `/api/*`, `/`, `/db`, slugs estaticos, `/db/:campaignId`, catch-all `/:param`, catch-all `/:param/:campaignId`, 404) garante que paths especificos casam antes do catch-all. Nenhum conflito identificado.
- **Equivalencia hot-path static vs catch-all**: `app.ts:121-122` (slugs ativos no startup) e `app.ts:132-156` (catch-all) ambos chamam o mesmo `redirectByGroup()`. Catch-all tem fallback robusto (`.catch(() => redirect(...))`).
- **Cobertura de branches** dos handlers: todos os caminhos retornam resposta. Nenhum dead-end / void-return identificado.
- **Os handlers de domain-group** (`list/create/update/delete/addDomains/removeDomains`) sao os mais limpos do codebase — todos seguem mesmo padrao de validacao + try/catch + status codes especificos.
- **Spec quality**: a maior parte dos issues e omissao de status codes 500/503, nao bugs no codigo. Codigo-fonte esta em estado bom.
