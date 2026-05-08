Voce e Athena, frontend-senior-developer (cobre Node/TS/Express). Modo: APLICAR — criar documentacao OpenAPI completa do projeto e expor via Redoc + Swagger UI.

## Objetivo
Adicionar documentacao automatica da API em `/redocs` (UI Redoc) e `/openapi.json` (spec). Cobrir TODOS os endpoints com request/response detalhados.

## Inventario de endpoints (mapa, voce confirma lendo o codigo)

### Sem prefixo (health + redirect hot path)
| Method | Path | Handler |
|--------|------|---------|
| GET | /health | HealthController.checkHealth |
| GET | /health/detailed | HealthController.checkHealthDetailed |
| GET | /health/ready | HealthController.checkReadiness |
| GET | /ping | inline (returns "pong") |
| GET | / | RedirectController.redirect (302 navigational) |
| GET | /db | RedirectController.redirectByGroup('db') |
| GET | /:slug | dinamico — slug ativo redireciona, senao redirect main |
| GET | /:slug/:campaignId | dinamico — idem com campaignId |

### `/api/domain-groups/*` (DomainGroupController)
| Method | Path | Body / Params |
|--------|------|---------------|
| GET | /api/domain-groups | list all |
| POST | /api/domain-groups | create |
| PUT | /api/domain-groups/:slug | update slug/name |
| DELETE | /api/domain-groups/:slug | delete |
| POST | /api/domain-groups/:slug/domains | add domains |
| DELETE | /api/domain-groups/:slug/domains | remove domains |

### `/api/*` (RedirectController via createRedirectRouter)
| Method | Path | Handler |
|--------|------|---------|
| GET | /api/redirect | controller.redirect |
| GET | /api/process | controller.process |
| GET | /api/stats | controller.getStats |
| GET | /api/rank | controller.getRank |
| GET | /api/rank-by-domain | controller.getRankByDomain |
| GET | /api/distinct/:field | controller.getDistinctValues |
| GET | /api/links | controller.getRedirectLinks |
| GET | /api/broad-clicks | controller.getBroadClicks |
| GET | /api/rules | controller.listRules |
| POST | /api/rules | controller.createRule |
| DELETE | /api/rules/:id | controller.deleteRule |
| GET | /api/inapp-rules | controller.listInAppRules |
| POST | /api/inapp-rules | controller.createInAppRule |
| DELETE | /api/inapp-rules/:id | controller.deleteInAppRule |

## Procedimento

### Passo 1 — Investigar handlers
Para CADA endpoint da lista acima, leia o handler correspondente em:
- `src/controllers/redirect-controller.ts`
- `src/controllers/domain-group-controller.ts`
- `src/controllers/health-controller.ts`

Extraia:
- Query params usados (`req.query.X`)
- Path params (`req.params.X`)
- Request body shape (`req.body.X`)
- Response status codes possiveis
- Response body shape (`res.json({...})`, `res.send(...)`, `res.redirect(...)`)
- Erros retornados (400/404/500 com mensagens)

Use Read e grep livremente. Se tiver duvida sobre semantica, INFIRA do nome + uso comum (Stats = retorna agregacao de clicks por periodo, etc.) — nao precisa entrevistar produto.

### Passo 2 — Instalar deps
```bash
cd /Users/caionorder/Dev/redirect
npm install --save swagger-ui-express
npm install --save-dev @types/swagger-ui-express
```

(Para Redoc, vamos usar HTML estatico com CDN — sem dep nova. Mas swagger-ui-express e util para ter `/swagger-ui` extra em paralelo, opcional.)

NAO atualize package versions de outras deps. Apenas adicione swagger-ui-express + types.

### Passo 3 — Criar `docs/openapi.yaml`
OpenAPI 3.0.3. Estrutura:

```yaml
openapi: 3.0.3
info:
  title: Redirect Service API
  description: |
    Servico de redirecionamento HTTP latency-critical com tracking de clicks e regras condicionais.
    
    - **Hot path**: `GET /`, `GET /db`, `GET /:slug` retornam 302 navegacional.
    - **API administrativa**: `/api/*` para gerenciar grupos de dominio, links, rules e in-app rules.
    - **Health**: `/health`, `/health/detailed`, `/health/ready`, `/ping`.
  version: 1.0.0
  contact:
    name: Caio Norder
servers:
  - url: https://redirect.belnk.in
    description: Producao
  - url: http://localhost:3000
    description: Local dev
tags:
  - name: redirect
    description: Hot path — redirecionamento navegacional 302
  - name: domain-groups
    description: Grupos de dominio (multi-tenant routing)
  - name: rules
    description: Regras de redirecionamento condicional
  - name: inapp-rules
    description: Regras de in-app browser (utm_campaign matching)
  - name: analytics
    description: Stats, ranking, links e clicks
  - name: health
    description: Liveness, readiness, ping
paths:
  # ... cada endpoint detalhado
components:
  schemas:
    # DomainGroup, Rule, InAppRule, Click, Link, Stats, etc.
  parameters:
    # parametros reusados (slug, ruleId, etc.)
  responses:
    # erros padronizados
```

Para CADA path, especifique:
- `summary` curto
- `description` explicando QUE faz e POR QUE
- `tags` (uma das tags acima)
- `parameters` (path + query separados)
- `requestBody` (so para POST/PUT, com `application/json` schema)
- `responses` minimo: 200 (ou 302 para redirect), 400 quando aplicavel, 404, 500
- Exemplos onde der pra inferir (ex: `?utm_source=facebook` em /redirect)

Schemas a definir em `components.schemas`:
- `DomainGroup` (slug, name, domains[], active, createdAt, updatedAt)
- `Rule` (id, conditions, destination, passQueryParams, description, createdAt)
- `InAppRule` (id, utm_campaign, destination, passQueryParams, description, createdAt)
- `RedirectLink` (link_id, domain, url, ...)
- `Click` (link_id, count, created_at)
- `BroadClick` (broad_id, date, count)
- `Stats` (totalClicks, byDomain, byPeriod, ...) — inferir do controller
- `RankItem` (domain, post_id, revenue, eCPM, clicks, ...)
- `HealthCheck` (status, mongo, redis, uptime)
- `Error` (error: string, message?: string, timestamp?: string)

Formate YAML legivel. Comentarios em PT quando ajudar. NAO copie codigo TS — descreva.

### Passo 4 — Criar `src/routes/docs-route.ts`
Router que monta:

- `GET /openapi.json` → serve a spec parseada (usar `js-yaml` ja existente? checar package.json. Se NAO existir, instalar `js-yaml` + `@types/js-yaml` como dev OU usar JSON em vez de YAML. Prefiro YAML para legibilidade humana — mas decidir baseado no que minimiza deps).
- `GET /redocs` → serve HTML estatico com Redoc CDN, apontando pro `/openapi.json`. Template:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Redirect API — Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
  <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
  <redoc spec-url='/openapi.json'></redoc>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>
```

- `GET /api-docs` → swagger-ui-express servindo a mesma spec (extra, porque o usuario falou "redocs com swagger" — entrega ambos os UIs).

### Passo 5 — Montar em `src/app.ts`
Rotas /redocs, /openapi.json e /api-docs vao ANTES do `if (db) { ... }` block (sempre disponiveis, independente de DB). Logo apos `app.use(createHealthRouter(db))`.

```ts
import { createDocsRouter } from './routes/docs-route';
// ...
app.use(createDocsRouter());
```

### Passo 6 — Validar
```bash
cd /Users/caionorder/Dev/redirect
npx tsc --noEmit  # deve passar EXIT=0
```

### Passo 7 — Verificar visualmente (opcional)
Se ambiente permitir, sugerir comando para rodar `npm run dev` e abrir `http://localhost:3000/redocs` para inspecao manual.

## Restricoes
- NAO commit
- NAO mexer em logica de redirect/business
- Pode usar `npm install` (esta task EXIGE novas deps)
- Manter compatibilidade com Node 23 e TS atual
- NAO documentar endpoints internos (cron, scheduled jobs) — so HTTP publico
- Expor `/redocs` SEM auth (mesmo padrao do resto do `/api`)
- Marcar no description do POST `/api/inapp-rules` que existe risco de XSS conhecido (ja triado pela equipe) se `destination` nao for validado — referenciar Aegis review como contexto historico, mas sem se aprofundar

## Risco
LOW. So adiciona arquivos de doc + routes, sem mexer em logica existente.

## Entregavel
`scratchpad/agent-athena-docs.md`:
- Lista de arquivos criados/modificados
- Resumo do spec (count de paths, schemas)
- Output do `npx tsc --noEmit`
- Comando para o usuario testar (`npm run dev` + abrir /redocs)
- Pontos onde voce inferiu semantica e merece review (ex: "stats agrupa por dia, inferi do nome do campo X")

## Memoria Obsidian
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-08_10-15_api-docs-athena.md
com tags [docs, openapi, redoc, swagger].

## Passo final OBRIGATORIO
Apos tudo aplicado + tsc passando + scratchpad + obsidian, rode EXATAMENTE:
cmux wait-for --signal done-athena-docs-1730986000
