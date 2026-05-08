# Poseidon — Implementacao Fase 1 (DB)

Aplicado em 2026-05-08. Itens 1.9, 1.10, 1.11, 1.12, 1.13 do `scratchpad/PERFORMANCE_PLAN.md`.

---

## Arquivos modificados

### `src/config/database.ts` (1.12)
Tunadas as options no `MongoClient.connect`:
- `appName: 'redirect'`
- `maxPoolSize: 30` (era default 100; com 4–8 workers cluster respeita orcamento)
- `minPoolSize: 5`
- `maxIdleTimeMS: 60_000`
- `serverSelectionTimeoutMS: 5_000` (era 30s)
- `socketTimeoutMS: 20_000` (era 0/infinito)
- `connectTimeoutMS: 5_000`
- `waitQueueTimeoutMS: 2_000`
- `retryWrites: true`, `retryReads: true`

Mantido o `process.exit(1)` no `catch` (instrucao explicita; tratamento "logar e expor unhealthy" e fase posterior).

### `src/config/redis.ts` (1.13)
Adicionadas options ao `new Redis({...})`:
- `connectTimeout: 5_000`
- `commandTimeout: 2_000`
- `maxRetriesPerRequest: 3`
- `enableOfflineQueue: false`
- `keepAlive: 30_000`

`retryStrategy` mantido. `redis.on('error')` mantido.

---

## Arquivos criados

### `migrations/001-redirects-links-indexes.ts`
Cria 3 indices em `redirects_links`:
- `{ domain: 1, url: 1 }` unique — `domain_url_unique`. Faz `aggregate $group` antes para detectar duplicatas. Se houver, cria como **NAO unique** e loga aviso (operador resolve duplicatas e recria como unique manualmente).
- `{ domain: 1, created_at: -1 }` — `domain_createdAt`
- `{ created_at: -1 }` — `createdAt`

Todos `background: true`.

### `migrations/002-redirects-clicks-count-index.ts`
Cria `{ count: -1 }` em `redirects_clicks` — nome `count_desc`, `background: true`.

### `migrations/003-broad-clicks-date-index.ts`
Cria `{ date: 1, broad_id: 1 }` em `broad_clicks` — nome `date_broadId`, `background: true`. Complementa o unique `{broad_id, date}` ja existente.

### `migrations/README.md`
Lista os 3 scripts, ordem, e comando para rodar:
```bash
npx tsx migrations/001-redirects-links-indexes.ts
npx tsx migrations/002-redirects-clicks-count-index.ts
npx tsx migrations/003-broad-clicks-date-index.ts
```

Pre-requisitos documentados (`MONGODB_URL` no `.env`, `MONGO_DB_NAME` opcional).

---

## Padrao dos migrations

Boilerplate identico nos 3:
- `import { MongoClient } from 'mongodb'` + `dotenv`
- Le `MONGODB_URL` do env, valida presenca, conecta com `appName: 'redirect-migrations'`
- `try/finally` com `client.close()`
- Sem framework de tracker — execucao manual.

---

## Validacao TypeScript

Comando: `npx tsc --noEmit`

Resultado:
- **Erro pre-existente em `src/app.ts:106`** — `createRedirectRouter(db)` recebe `Db` mas espera `RedirectController`. **Nao introduzi**, fora de escopo (isto e implementacao de routing, dominio Athena/Zeus).
- **Meus arquivos validam isolados** — rodando `tsc --noEmit` apontando explicitamente em `src/config/database.ts`, `src/config/redis.ts` e os 3 migrations: exit 0, zero erros.

---

## Riscos a validar manualmente

1. **`enableOfflineQueue: false` em Redis** — em outage do Redis, comandos `await this.redisClient.X()` rejeitam imediatamente. Verifiquei `redirect-controller.ts`:
   - Hot-path leitura (`getGlobalVisitIndex` l.589-598, `addVisitedDomain` l.603-613, `getBestRpsLink` l.626-655, `getRulesFromRedis` l.729-731, `getInAppRulesFromRedis` l.894-896, `getBestLinksMapForGroup` l.689-694) tem guard `if (!this.redisClient) return ...` mas **NAO tem try/catch** ao redor do await. Com `enableOfflineQueue:false`, em outage do Redis, esses awaits podem **lancar excecao nao tratada** que sobe pelo Express.
   - Hot-path escrita (`saveRules` l.748-749, `saveInAppRules` l.913-914) idem.
   - Fire-and-forget (l.1156, l.1292) ja tem `.catch(() => {})` — OK.
   - **Recomendacao:** Athena adicionar `try/catch` envolvendo cada `await this.redisClient.X()` em hot-path, retornando o fallback equivalente ao branch `!this.redisClient` (cache em memoria, valor default, etc.). Fase posterior.
   - **Mitigacao temporaria caso saia em prod sem o try/catch:** monitorar errors em `/health` e Mongo writes para deteccao precoce. Em uma outage real do Redis sem try/catch, pages de redirect podem retornar 500 ate o Redis voltar.

2. **Indice unique `{domain, url}` em `redirects_links`** — script 001 detecta duplicatas e fallback para nao-unique com warn. Operador deve revisar saida do script e resolver duplicatas + recriar manualmente como unique se quiser garantir.

3. **`maxPoolSize: 30`** assume cluster com 4–8 workers (4×30=120, 8×30=240). Se o numero de workers mudar, reavaliar. Mongo Atlas tier atual deve aceitar 240+ conns confortavelmente.

4. **`socketTimeoutMS: 20_000`** corta queries longas. Aggregations pesadas (`getStats`, `getDataByPeriod` em `redirects_clicks` e `gam_ad_unit_key_values`) podem ficar acima de 20s sem indices apropriados. **Aplicar migrations 001/002/003 ANTES** ou pode haver requests caindo por timeout que antes funcionavam (lentas, mas funcionavam).

5. **`retryReads: true`** — driver 6.x ja default mas explicito. OK.

---

## Proximos passos sugeridos (fora desta fase)

- Athena: try/catch em redirect-controller.ts (item 1 acima).
- Daedalus/Zeus: corrigir `src/app.ts:106` (assinatura de `createRedirectRouter`).
- Operador: rodar `npx tsx migrations/00X` em ambiente de homolog antes de prod.
- Fase 2 do plano: Poseidon retorna para indices `gam_ad_unit_key_values` (4o migration) e estrategia de retencao (TTL).
