Voce e Athena, frontend-senior-developer (cobre Node/TS). Modo READ-ONLY. NAO edite codigo. NAO commite. Apenas audite.

## Objetivo
Auditar cada endpoint documentado em `docs/openapi.yaml` contra o handler real, e produzir checklist PASS/WARN/FAIL por endpoint.

## Procedimento

Para cada endpoint listado em `docs/openapi.yaml` (24 paths), faca:

1. **Rota mounted?** Confirme que existe em `src/routes/*.ts` ou `src/app.ts`.
2. **Handler existe?** Confirme metodo do controller correspondente em `src/controllers/*.ts`.
3. **Path/query params**: o que o spec diz que recebe vs o que o handler de fato consome (`req.params.X`, `req.query.X`).
4. **Body schema** (POST/PUT): comparar `requestBody` do spec com o que o handler le de `req.body`.
5. **Response status**: spec lista 200/302/400/404/500 etc. Handler retorna esses mesmos status?
6. **Response shape**: spec descreve `application/json` schema. Handler faz `res.json(X)` que bate?
7. **Error paths cobertos**: handler tem try/catch? Que codes retorna em erro?
8. **Bugs runtime**: padroes obvios — uso de var nao definida, await em nao-Promise, retorno inconsistente, branch sem return, etc.

## Resultado por endpoint

Use formato:
```
### GET /api/rules
- Status: PASS | WARN | FAIL
- Mounted: src/routes/redirect-route.ts:48 ✓
- Handler: redirect-controller.ts:803 listRules ✓
- Spec match: 200 OK retorna array de Rule ✓
- Findings:
  - [se houver]
```

Se for PASS limpo, pode usar uma linha so.

## Categorias de severidade

- **PASS**: handler bate com spec, sem bugs visiveis
- **WARN**: discrepancia leve (ex: spec diz `200` mas handler tambem retorna `204` em caso vazio; ou response field name divergence) — endpoint funciona mas spec impreciso
- **FAIL**: handler quebrado (referencia metodo inexistente, retorno inconsistente, query field errado, etc.)

## Endpoints a auditar (24)

### Hot path (5)
- GET /
- GET /db
- GET /db/{campaignId}
- GET /{slug}
- GET /{slug}/{campaignId}

Para o hot path, valide especificamente:
- Que `redirect()` e `redirectByGroup()` em redirect-controller.ts retornam SEMPRE algo (302, 503, ou error). Sem branch que cai em void.
- Que dynamic routes registradas no startup (em `app.ts:108-118`) e o catch-all `/:param` em `app.ts:124-148` produzem comportamento equivalente para slugs ativos.

### Health (4)
- GET /health
- GET /health/detailed
- GET /health/ready
- GET /ping

### Domain groups (6 ops em 3 paths)
- GET /api/domain-groups
- POST /api/domain-groups
- PUT /api/domain-groups/{slug}
- DELETE /api/domain-groups/{slug}
- POST /api/domain-groups/{slug}/domains
- DELETE /api/domain-groups/{slug}/domains

### API admin/analytics (8)
- GET /api/redirect
- GET /api/process
- GET /api/stats
- GET /api/rank
- GET /api/rank-by-domain
- GET /api/distinct/{field}
- GET /api/links
- GET /api/broad-clicks

### Rules (3 ops em 2 paths)
- GET /api/rules
- POST /api/rules
- DELETE /api/rules/{id}

### In-app rules (3 ops em 2 paths)
- GET /api/inapp-rules
- POST /api/inapp-rules
- DELETE /api/inapp-rules/{id}

## Restricoes
- READ-ONLY. NAO edite arquivos. NAO commite.
- NAO rode o servidor (`npm run dev`).
- NAO conecte em Mongo/Redis externo.
- Use Read e grep livremente.
- Tempo: maximo 15min — se demorar mais, priorize endpoints de admin/analytics (mais provaveis de ter bugs) e marque os outros como "not audited".

## Entregavel
`scratchpad/agent-athena-audit.md`:

# Athena — Static Audit (24 endpoints)

## Verdict resumido
- X PASS, Y WARN, Z FAIL

## Por endpoint
... (24 sections)

## Top issues a resolver (priorizado)
1. ...

## Notas finais

## Memoria Obsidian
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-08_10-50_endpoints-audit-athena.md

## Passo final OBRIGATORIO
Apos terminar:
cmux wait-for --signal done-athena-audit-1730987800
