# Agent: Athena (frontend-senior-developer) — API Docs

## Objetivo
Adicionar documentacao OpenAPI 3.0.3 do projeto e expor via Redoc (`/redocs`) + Swagger UI (`/api-docs`) + spec JSON (`/openapi.json`).

## Arquivos criados
- `docs/openapi.yaml` — spec completa (24 paths, 14 schemas, 3 reusable parameters, 2 reusable responses).
- `src/routes/docs-route.ts` — router que serve:
  - `GET /openapi.json` (spec parseada do YAML, cache em memoria)
  - `GET /redocs` (HTML estatico com Redoc CDN)
  - `GET /api-docs` (Swagger UI completo)

## Arquivos modificados
- `src/app.ts` — import e mount de `createDocsRouter()` logo apos `createHealthRouter`. Disponivel mesmo sem DB.
- `package.json` (via `npm install`):
  - `dependencies`: `swagger-ui-express ^5.0.1`, `js-yaml ^4.1.1`
  - `devDependencies`: `@types/swagger-ui-express ^4.1.8`, `@types/js-yaml ^4.0.9`
- `package-lock.json` regenerado.

## Resumo do spec
- **24 paths** cobrindo todos os endpoints do brief:
  - Hot path: `/`, `/db`, `/db/{campaignId}`, `/{slug}`, `/{slug}/{campaignId}` (5)
  - Health: `/health`, `/health/detailed`, `/health/ready`, `/ping` (4)
  - Domain groups: `/api/domain-groups`, `/api/domain-groups/{slug}`, `/api/domain-groups/{slug}/domains` (3)
  - API redirect/admin/analytics: `/api/redirect`, `/api/process`, `/api/stats`, `/api/rank`, `/api/rank-by-domain`, `/api/distinct/{field}`, `/api/links`, `/api/broad-clicks` (8)
  - Rules: `/api/rules`, `/api/rules/{id}` (2)
  - In-app rules: `/api/inapp-rules`, `/api/inapp-rules/{id}` (2)
- **14 schemas reusable**: `Error`, `HealthBasic`, `HealthDetailed`, `DomainGroup`, `Rule`, `InAppRule`, `RankedLink`, `RankResultItem`, `RankResult`, `RankByDomainItem`, `RankByDomainGroup`, `Stats`, `RedirectLink`, `BroadClick`.
- **6 parameters reusable**: `GroupSlug`, `DateStart`, `DateEnd`, `UtmCampaign`, `UtmSource`, `UtmMedium`, `Broad`, `Language`.
- **2 responses reusable**: `NotFound`, `InternalError`.
- **7 tags**: `redirect`, `domain-groups`, `rules`, `inapp-rules`, `analytics`, `health`, `admin`.

## Validacao
- `npx tsc --noEmit` -> **EXIT=0** (sem erros).
- `js-yaml` parse do `docs/openapi.yaml` -> **24 paths, 14 schemas, openapi: 3.0.3**.

## Como testar
```bash
cd /Users/caionorder/Dev/redirect
npm run dev
# Em outro terminal ou browser:
#   http://localhost:3000/redocs       (Redoc UI)
#   http://localhost:3000/api-docs     (Swagger UI)
#   http://localhost:3000/openapi.json (spec JSON)
```

## Pontos onde inferi semantica (merece review do produto)
1. **`/api/stats`**: a estrutura `{ gam, clicks, traffic }` veio direto do controller. `traffic.totalDomains`/`totalDomainsDb` sao derivados de `getDomains('main'/'db').length` (so contam `main` e `db`, nao todos os grupos ativos — talvez intencional, talvez nao).
2. **`/api/process`**: o response `data` muda de shape (array vs map) baseado em `?slug=` presente ou ausente. Documentei via `oneOf`. Confirma se o contrato e esse.
3. **`/api/rank`** retorna sempre `{ main, db }` — fixo, nao olha `getActiveSlugs()`. Se grupos novos forem criados, esse endpoint nao retornara dados deles. Documentei como esta hoje.
4. **`/api/links`**: quando `?domain=` e passado, ignora `limit`/`offset` e devolve todos os links daquele dominio (vi no controller). Reflete isso no description.
5. **`/api/inapp-rules` (POST)**: na description marquei o aviso XSS (`destination` injetado em template HTML do iframe sem validacao) referenciando o review historico do Aegis, conforme pediu o brief.
6. **Rotas dinamicas `/{slug}` e `/{slug}/{campaignId}`**: documentei como rotas genericas com `pattern: ^[a-z0-9-]+$`. Em runtime sao registradas em duas formas (estaticas no startup pra slugs existentes + catch-all pro resto), mas do ponto de vista de cliente HTTP e equivalente.
7. **Health responses**: `services.database/redis` tem valor `unknown` quando o servico nao foi configurado (Mongo nao injetado). Documentei o enum com os 3 valores.

## Notas
- Spec carregada uma vez na primeira request (`cachedSpec` em memoria). Reload exige restart do processo — nao e hot-reloadable hoje. Se isso virar dor, simples colocar `fs.watch`.
- Redoc e servido via CDN (`cdn.redoc.ly`), sem bundler. Swagger UI e bundled via `swagger-ui-express` (assets locais).
- Nenhum endpoint `/cron`, `/etl`, `/scheduled` foi documentado — sao internos via cron, nao HTTP publico.
- Spec carrega de `docs/openapi.yaml` resolvido via `path.resolve(__dirname, '../../docs/openapi.yaml')`. Funciona tanto em dev (tsx, `__dirname` aponta para `src/routes`) quanto em build (`dist/routes`, sobe 2 niveis para encontrar `docs/`).

## Restricoes respeitadas
- Sem commit
- Sem mexer em logica de redirect/business
- Compatibilidade Node 23 + TS atual mantida
- `/redocs` exposto sem auth (mesmo padrao do `/api`)
- Apenas endpoints HTTP publicos documentados
