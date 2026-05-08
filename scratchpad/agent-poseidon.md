# Poseidon — Database Performance Review (redirect)

Stack: Node 20 + TS + Express + MongoDB driver 6.x + ioredis 5.x. Hot-path: redirect HTTP latency-sensitive em cluster (default = N CPUs). Avaliação read-only.

---

## MongoDB — schemas e indices

### `redirects_clicks` (`redirect-click-repository.ts`)
| Indice atual | Status |
| --- | --- |
| `{ link_id: 1 }` unique (linha 14) | OK |

Recomendados:
- **[HIGH] `{ count: -1 }`** — `getAllClicks` (l.69-75), `getTopClicks` (l.81-86), `getClicksInRange` (l.198-204) ordenam/filtram por `count` sem indice → COLLSCAN+in-memory sort.
  ```js
  db.redirects_clicks.createIndex({ count: -1 })
  ```
- **[MED] `{ created_at: 1 }` TTL** se decidir reter clicks só X dias (ver "Estrategia de retencao").

### `broad_clicks` (`broad-click-repository.ts`)
| Indice atual | Status |
| --- | --- |
| `{ broad_id: 1, date: 1 }` unique (l.10) | OK p/ `incrementClick` |

Recomendados:
- **[HIGH] `{ date: 1, broad_id: 1 }`** — `getClicks(start,end)` (l.42-77) filtra **só por date** (l.45-49) + `$group` por `broad_id`. O indice atual `(broad_id, date)` NÃO atende prefix-rule pra filtro só em `date` → COLLSCAN. Indice invertido cobre `$match` + acelera o `$group`.
  ```js
  db.broad_clicks.createIndex({ date: 1, broad_id: 1 })
  ```

### `redirects_links` (`redirect-link-repository.ts`)
| Indice atual | Status |
| --- | --- |
| Nenhum (apenas `_id`) | **BLOCKER** |

Recomendados:
- **[BLOCKER] `{ domain: 1, url: 1 }`** — `getLinkByDomainAndUrl` (l.32-34) é COLLSCAN. Idealmente unique se semântica permitir.
  ```js
  db.redirects_links.createIndex({ domain: 1, url: 1 }, { unique: true })
  ```
- **[HIGH] `{ domain: 1, created_at: -1 }`** — `getLinksByDomain` (l.72-77) filtra+ordena.
  ```js
  db.redirects_links.createIndex({ domain: 1, created_at: -1 })
  ```
- **[MED] `{ created_at: -1 }`** — `getAllLinks` (l.59-66) sort+skip; sem indice é toda lida em memória.

### `domain_groups` (`domain-group-repository.ts`)
| Indice atual | Status |
| --- | --- |
| `{ slug: 1 }` unique (l.14) | OK |

- **[LOW]** `{ active: 1, createdAt: -1 }` se a coleção crescer; hoje é trivial (cache em memória 60s no service).

### `gam_ad_unit_key_values` (read-only, ETL externo) — **CRÍTICO**
Sem indice criado pelo app. Hot-path: `BuilderService.build` (`builder-service.ts:7-213`) e `findByQuery` (`gam-ad-unit-repository.ts:44-88`). Filtros recorrentes: `date` (range), `domain` (`$in`), `custom_key`, `custom_value`, `network`, `country`. Sort: `{ date: -1, revenue: -1 }`.

- **[BLOCKER] `{ date: 1, domain: 1, custom_key: 1, custom_value: 1 }`** — cobre o pipeline cron de 15 min em `executeProcessForGroup` (`redirect-controller.ts:188-200`) que filtra `date=todayStr`, `domain∈grupo`, `custom_key='id_post_wp'`.
  ```js
  db.gam_ad_unit_key_values.createIndex(
    { date: 1, domain: 1, custom_key: 1, custom_value: 1 },
    { name: 'date_domain_key_value' }
  )
  ```
- **[HIGH] `{ date: 1, domain: 1 }`** — fallback/leitura para `getStats`, `getDataByPeriod`.
- **[HIGH] regex `ad_unit_name`** (`gam-ad-unit-repository.ts:79`, `builder-service.ts:54-58`) — `$regex` sem `^` não usa indice. Documentar/limitar.
- **[MED] `{ date: 1 }`** isolado — `count`, `distinct`, `getStats` quando só filtra por data.

---

## MongoDB — queries

| File:Line | Problema | Severidade | Fix |
| --- | --- | --- | --- |
| `redirect-click-repository.ts:209-228` `incrementMultipleClicks` | Loop de N `updateOne` (1 RTT cada) com `upsert`. Para N=50 = 50 RTTs sequenciais. | **BLOCKER** | Trocar por `bulkWrite([...])` ordered:false. |
| `redirect-click-repository.ts:236-303` `getClickCountsBySuffixes` | `$or` com lista de `$regex: '_${suffix}$'` (anchor só no fim) → não usa indice em `link_id`. Em volume grande = COLLSCAN + regex por documento. Adicionalmente o pipeline reconstrói o sufixo via `$reduce` no servidor (CPU caro). | **HIGH** | (1) Persistir `domain` e `post_id` denormalizados em `redirects_clicks` no `incrementClick` para indexar `{domain:1, post_id:1}`. (2) `$match` direto, sem `$let/$reduce`. Migration de backfill necessária. |
| `redirect-click-repository.ts:69-75` `getAllClicks` | `find({}).skip(offset).sort({count:-1})` — sem indice, em-memória; deep paging com `skip` é O(n). | HIGH | Indice `{count:-1}` + paginação por cursor (`{count:{$lt:lastCount}}`) ao invés de skip. |
| `redirect-click-repository.ts:144-150` `getTotalClicksSum`, l.155-192 `getStats` | Aggregate full-collection scan a cada chamada. Caso seja chamado por endpoint público = pressão constante. | MED | Cache 60s em Redis; ou substituir por `db.collection.estimatedDocumentCount()` quando aproximação serve. |
| `broad-click-repository.ts:42-77` `getClicks` | Sem `$project` para limitar campos lidos antes do `$group`. Não há `allowDiskUse`. | LOW | Adicionar `$project` antes do `$group` (campos `broad_id`, `count`). Considerar `allowDiskUse:true` se cardinalidade `broad_id` × dias for grande. |
| `redirect-link-repository.ts:32-34` `getLinkByDomainAndUrl` | COLLSCAN sem indice composto. | BLOCKER | Indice `{domain:1, url:1}` (ver acima). |
| `gam-ad-unit-repository.ts:79` `ad_unit_name regex` | `$regex` case-insensitive sem ancora → COLLSCAN garantido. | HIGH | Considerar text index ou rejeitar regex no client. |
| `builder-service.ts:62-200` pipeline | `$match` correto na primeira posição (OK). Mas sem `allowDiskUse:true` — se coleção `gam_ad_unit_key_values` for grande e o `$group` ultrapassar 100MB, o pipeline aborta. `$addFields` com `$toInt`/`$toDouble` em todas as rows pré-`$group` desperdiça CPU; melhor seria ETL gravar campos já tipados. | HIGH | `repository.query().aggregate(pipeline, { allowDiskUse: true })`. Tipos numéricos canonicos no ETL. |
| `gam-ad-unit-repository.ts:82-88` `findByQuery` | Falta `.project()` — devolve documentos inteiros (centenas de campos potenciais) por causa de filtros de UI. | MED | Projection explicita só com campos consumidos. |
| `redirect-controller.ts:1144-1147, 1280-1283` `incrementClick` em hot-path | A cada redirect 1 `findOneAndUpdate` upsert sem await (fire-and-forget OK), mas roda no caminho da resposta antes de `res.redirect`. Sob carga, o `incrementClick` está atrasando o redirect (latência cauda). | MED | Ja é fire-and-forget, ok. Mas: bufferizar em memória (counter local por worker) e flush via `bulkWrite` a cada N segundos elimina N RTTs Mongo por segundo. |
| `domain-group-repository.ts:48-60` `updateBySlug` etc. | `findOneAndUpdate` com `returnDocument:'after'` — OK. | OK | — |

### Falta de `readPreference`
Aggregations pesadas (`getStats`, `getDataByPeriod`, `getClickCountsBySuffixes`, `BuilderService.build`) rodam contra primary. Em replica set, mover para `secondaryPreferred`:
```ts
this.collection.aggregate(pipeline, { readPreference: 'secondaryPreferred', allowDiskUse: true })
```

---

## MongoDB — connection

`src/config/database.ts` — **estado atual: padrão de driver, zero tuning.**

```ts
MongoClient.connect(mongoUrl)   // sem options
```

Defaults atuais (driver 6.x): `maxPoolSize=100`, `minPoolSize=0`, `serverSelectionTimeoutMS=30000`, `socketTimeoutMS=0`, `retryWrites=true`, `w='majority'`.

Problemas:
- **[HIGH]** Cluster com `WORKER_COUNT=4` → cada worker tem seu próprio pool de até 100 = potencial de 400 conexões simultâneas. Se o Mongo aceita só ~500, qualquer pico estoura.
- **[HIGH]** `socketTimeoutMS=0` (infinito) — query hung trava o request indefinidamente.
- **[MED]** Não há `maxIdleTimeMS` → conexões idle ficam abertas.
- **[MED]** `serverSelectionTimeoutMS=30000` é alto demais para hot-path: se o primary cair, requests ficam pendurados por 30s antes do erro.
- **[BLOCKER]** Em erro de conexão, `process.exit(1)` (l.9) — em cluster, o worker é re-fork pelo master, mas se o Mongo está down todos os workers entram em loop de boot. Logar e expor `/health` como unhealthy é melhor (controller já trata).
- Falta `appName` para identificar conexões em `db.currentOp()`.

Recomendado:
```ts
MongoClient.connect(mongoUrl, {
  appName: 'redirect',
  maxPoolSize: 30,                 // 30 × 4 workers = 120, dentro do orçamento
  minPoolSize: 5,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 5_000,
  socketTimeoutMS: 20_000,
  connectTimeoutMS: 5_000,
  waitQueueTimeoutMS: 2_000,
  retryWrites: true,
  retryReads: true,
  readPreference: 'primaryPreferred',
  writeConcern: { w: 1 },          // counters podem ser w:1, fire-and-forget OK
})
```

`writeConcern: w:1` pra `incrementClick` reduz latência de write (default majority espera ack de N nós). Para `redirects_links` (CRUD admin) manter majority.

---

## Redis — patterns

Uso concentrado em `redirect-controller.ts` (controller também faz contagem global e sets de visitantes — overlap com escopo de cache).

### Roundtrips desnecessários

| File:Line | Problema | Fix |
| --- | --- | --- |
| `redirect-controller.ts:603-613` `addVisitedDomain` | 3 RTTs sequenciais: `SADD` → `TTL` → `EXPIRE`. | **[HIGH]** Pipeline ou Lua script: `EXPIRE key 3600 NX` (Redis 7+) faz isso atomicamente em 1 op + `SADD`. Pipeline reduz pra 1 RTT. |
| `redirect-controller.ts:589-598` `getGlobalVisitIndex` | INCR + EXPIRE em 2 RTTs. **Race condition**: se `count===1` mas o segundo request chega entre `INCR` e `EXPIRE`, vê `count=2` e nunca seta TTL → chave sem expiração acumula. | **[HIGH]** Lua script atômico `INCR + EXPIRE NX`, ou usar `SET key 0 EX 3600 NX` antes (cobre janela). |
| `redirect-controller.ts:626-655` `getBestRpsLink` | `SMEMBERS` + (loop) `SADD` + `TTL` + `EXPIRE` — até 4 RTTs por request no caminho de redirect. | **[HIGH]** Pipeline `SMEMBERS` na entrada, depois `MULTI/EXEC` pra `SADD+EXPIRE NX`. |
| `redirect-controller.ts:1156, 1292` `set recent:${clientIp}` | Fire-and-forget OK, mas a key **nunca é lida** em nenhum lugar do código (verifiquei `grep recent`). | **[MED]** Dead write — remover para economizar RTT/memória, OU implementar leitura para anti-duplicação que parece ser a intenção do comentário. |

### Cache stampede
- `getBestLinksMapForGroup` (l.679-703) — TTL Redis 3600s + cache em memória 60s. Se Redis expira e a CRON (executa a cada 15 min) falha por mais de 1h, **N workers convergem no fallback random**. Não há jitter no TTL nem distributed lock. **[MED]** Adicionar jitter (`3600 + rand(300)`) e considerar lock se a popularização for cara.

### Serialização JSON
- `getBestLinksMapForGroup`/`saveRules` (l.692-694, 749, 914): `JSON.parse/stringify` do ranking inteiro a cada request (top 50 itens, ~10–15 KB). Sob 1k RPS por worker = ~10MB/s parsing. **[MED]** Alternativas:
  - Cache parsed em memória por TTL curto (já tem 60s, OK — confirmar invalidação).
  - `redis hash` (HMGET) lendo só o slot necessário pelo `visitIndex % length`.
  - Compressão (zstd/snappy) — provavelmente over-engineering.

### Falta de TTL
- `redirect:rules` (l.749) e `redirect:inapp_rules` (l.914) gravados sem TTL — OK, são configs persistentes. **Mas** se nunca migram para outra storage, considerar persistência em Mongo + Redis como cache puro.
- `redirect:global_counter:${slug}` — TTL 3600s só na primeira vez (vide bug acima).

### Nada de `KEYS`/`SCAN`
Verificado: nenhum uso de `KEYS` ou `SCAN` no código. **OK**.

---

## Redis — connection

`src/config/redis.ts` — minimo.

```ts
new Redis({ host, port, password, retryStrategy })
```

Faltando:
- **[HIGH] `connectTimeout: 5000`** — sem isso, conexão pendura.
- **[HIGH] `commandTimeout: 2000`** — comandos no hot-path não devem pendurar > 2s.
- **[MED] `maxRetriesPerRequest: 3`** (default 20) — em incidente, request retém worker por longo tempo.
- **[MED] `enableReadyCheck: true`** (default true) — confirmar.
- **[MED] `enableOfflineQueue: false`** em hot-path — quando Redis cai, melhor falhar rapido e cair pra fallback do código (já existe `if (!this.redisClient)`).
- **[LOW] `keepAlive: 30000`** — reduz reconnect em NAT/LB.
- **[LOW] Pool/cluster?** ioredis usa 1 conexão por instancia. Em Node single-threaded por worker, OK. Não precisa pool.

Recomendado:
```ts
new Redis({
  host, port, password,
  connectTimeout: 5_000,
  commandTimeout: 2_000,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  keepAlive: 30_000,
  retryStrategy: (times) => Math.min(times * 50, 2000),
})
```

---

## Estrategia de retencao (clicks)

**Crescimento:**
- `redirects_clicks`: cardinalidade = unique `link_id` = `rank{N}_[slug_]{domain}_{postId}` × variantes (`bestrps_`, `fallback_`). Para 50 ranks × 5 grupos × ~20 dominios × ~10 postIds ≈ 50k linhas teto, mas com churn de postIds **cresce indefinidamente**.
- `broad_clicks`: linha por `(broad_id, date)`. Se há 1000 broads ativos × 365 dias = 365k linhas/ano. Ok mas sem fim.

**Recomendacao:**
- **[HIGH] `redirects_clicks`**: TTL index em `created_at` de 90d se o ranking é granular. Alternativa: archive trimestral via cron pra `redirects_clicks_archive`.
  ```js
  db.redirects_clicks.createIndex({ created_at: 1 }, { expireAfterSeconds: 7776000 })
  ```
  *Cuidado:* o `count` é cumulativo desde o create — TTL apaga o histórico inteiro. Se o produto precisa do histórico de cliques agregado, a estratégia deve ser bucketing por dia/semana (ex: novo schema `{ link_id, period, count }`), não TTL puro.
- **[MED] `broad_clicks`**: TTL 365d (já tem `date` separado, agregação por dia).
  ```js
  db.broad_clicks.createIndex({ created_at: 1 }, { expireAfterSeconds: 31536000 })
  ```
- **[MED] Schema bucketing**: se a leitura é "clicks por dia/semana", reescrever pra bucket pattern `{link_id, day:'YYYY-MM-DD', count}` permite TTL trivial e queries time-series. Migração custosa.

---

## Top 5 quick wins (impacto/esforço)

1. **Indice `{domain:1, url:1}` em `redirects_links` + `{domain:1, created_at:-1}`** — 5 minutos, elimina COLLSCAN em CRUD admin. **[BLOCKER]**
2. **Tunar `MongoClient.connect`** com `maxPoolSize:30`, `socketTimeoutMS:20000`, `serverSelectionTimeoutMS:5000`, `appName:'redirect'`, `retryReads:true` — 10 minutos, blinda contra hangs no hot-path. **[HIGH]**
3. **`bulkWrite` em `incrementMultipleClicks`** (`redirect-click-repository.ts:209-228`) — substitui N RTTs por 1. **[HIGH]**
4. **Indice composto em `gam_ad_unit_key_values`**: `{date:1, domain:1, custom_key:1, custom_value:1}` — destrava o cron de 15 min e qualquer leitura analítica. **[BLOCKER]** se a coleção for grande.
5. **`commandTimeout` + `maxRetriesPerRequest:3` no ioredis** — previne worker pendurado quando Redis degrada. **[HIGH]**

---

## Migrations / scripts necessarios

(Apenas listar — Poseidon não cria/aplica.)

1. `migrations/001-redirects-links-indexes.ts`
   - `db.redirects_links.createIndex({domain:1, url:1}, {unique:true, background:true})`
   - `db.redirects_links.createIndex({domain:1, created_at:-1}, {background:true})`
   - `db.redirects_links.createIndex({created_at:-1}, {background:true})`
2. `migrations/002-redirects-clicks-count-index.ts`
   - `db.redirects_clicks.createIndex({count:-1}, {background:true})`
3. `migrations/003-broad-clicks-date-index.ts`
   - `db.broad_clicks.createIndex({date:1, broad_id:1}, {background:true})`
4. `migrations/004-gam-ad-unit-indexes.ts` (validar com DBA — coleção pode ser grande, criar com `background:true`)
   - `db.gam_ad_unit_key_values.createIndex({date:1, domain:1, custom_key:1, custom_value:1}, {name:'date_domain_key_value', background:true})`
   - `db.gam_ad_unit_key_values.createIndex({date:1, domain:1}, {background:true})`
5. `migrations/005-clicks-retention.ts` (decisão de produto antes de aplicar — TTL apaga `count` cumulativo)
   - `db.broad_clicks.createIndex({created_at:1}, {expireAfterSeconds:31536000})`
   - opcional: `db.redirects_clicks.createIndex({created_at:1}, {expireAfterSeconds:7776000})`
6. `scripts/denormalize-redirects-clicks.ts` (opcional, se aceitar refatorar)
   - Backfill de `domain`, `post_id` em `redirects_clicks` a partir do `link_id`, criar indice `{domain:1, post_id:1}`, reescrever `getClickCountsBySuffixes` sem regex/`$reduce`.
7. `scripts/refactor-mongo-config.ts`
   - Não é migration — refactor de `src/config/database.ts` com options.
8. `scripts/refactor-redis-config.ts`
   - Refactor de `src/config/redis.ts` com timeouts.

Aplicar 1, 2, 3, 5 e 7/8 (refactors de config) primeiro. Confirmar 4 com tamanho real da coleção `gam_ad_unit_key_values` antes — em coleção muito grande, criar índice exige planejamento de janela.
