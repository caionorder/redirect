Voce e Poseidon, database-engineer. Modo: APLICAR mudancas em config DB e criar migrations. Nao commitar. Nao rodar contra Mongo real. Nao deploy.

## Contexto
Projeto: /Users/caionorder/Dev/redirect (Node + TS + Mongo driver 6.x + ioredis 5.x + cluster mode).

Sua analise esta em scratchpad/agent-poseidon.md. Voce vai aplicar Fase 1 dos itens DB do plano `scratchpad/PERFORMANCE_PLAN.md`.

## Suas mudancas (Fase 1 — itens 1.9, 1.10, 1.11, 1.12, 1.13)

### 1.12 — Tunar `src/config/database.ts`
Hoje: `MongoClient.connect(mongoUrl)` sem options. Em cluster com 8 workers e default pool 100 = 800 conns potenciais.

Fix: passar options:
```ts
MongoClient.connect(mongoUrl, {
  appName: 'redirect',
  maxPoolSize: 30,
  minPoolSize: 5,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 5_000,
  socketTimeoutMS: 20_000,
  connectTimeoutMS: 5_000,
  waitQueueTimeoutMS: 2_000,
  retryWrites: true,
  retryReads: true,
})
```
Adapte ao codigo existente (pode estar usando `new MongoClient(url)` em vez de `connect`). Mantenha o fluxo de erro existente (NAO mude `process.exit(1)` se ele ja existe — isso e tratado em fase posterior).

### 1.13 — Tunar `src/config/redis.ts`
Hoje: `new Redis({ host, port, password, retryStrategy })` minimo.

Fix: adicionar:
```ts
{
  ...,
  connectTimeout: 5_000,
  commandTimeout: 2_000,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  keepAlive: 30_000,
}
```

CUIDADO `enableOfflineQueue: false`: hot path precisa ter try/catch ao chamar Redis. Verifique `redirect-controller.ts` e `services/`. Se o codigo ja trata `if (!this.redisClient)` ou tem try/catch nas chamadas Redis, pode aplicar. Se NAO, marque no scratchpad como **risco a validar** e ainda assim aplique (Athena pode adicionar try/catch se preciso, mas reportar).

### 1.9, 1.10, 1.11 — Migrations
O projeto NAO tem framework de migration (verificar). Crie diretorio `migrations/` na raiz se nao existir, com 3 scripts:

**`migrations/001-redirects-links-indexes.ts`**:
```ts
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

async function up() {
  const client = await MongoClient.connect(process.env.MONGODB_URL!);
  const db = client.db(process.env.MONGO_DB_NAME || 'redirect');
  const col = db.collection('redirects_links');
  await col.createIndex({ domain: 1, url: 1 }, { unique: true, background: true, name: 'domain_url_unique' });
  await col.createIndex({ domain: 1, created_at: -1 }, { background: true, name: 'domain_createdAt' });
  await col.createIndex({ created_at: -1 }, { background: true, name: 'createdAt' });
  console.log('OK migrations/001');
  await client.close();
}

up().catch((e) => { console.error(e); process.exit(1); });
```

**`migrations/002-redirects-clicks-count-index.ts`**:
```ts
// Cria { count: -1 } em redirects_clicks (background, named: count_desc)
```

**`migrations/003-broad-clicks-date-index.ts`**:
```ts
// Cria { date: 1, broad_id: 1 } em broad_clicks (background, named: date_broadId)
```

CUIDADO no 001: a indexacao unique pode falhar se ja houver duplicatas em redirects_links. No script, ANTES de createIndex, faca um check via aggregation `$group` para detectar duplicatas e logar (sem abortar). Se houver duplicatas, criar indice **NAO unique** e adicionar comentario no proprio script alertando. Documentar em scratchpad.

Adicionar nome do indice em todos os createIndex (parametro `name`).

Use o mesmo padrao do 001 (boilerplate) nos 3 scripts.

Nao crie tooling de "migration tracker" (sem framework). So scripts standalone executados manualmente: `npx tsx migrations/001-redirects-links-indexes.ts`.

Adicionar uma `migrations/README.md` curta listando os 3 scripts, ordem, e o comando para rodar (`npx tsx migrations/00X-...ts`).

## Restricoes
- NAO commit
- NAO conectar em Mongo real (so cria os arquivos)
- NAO rodar `npm install`
- Use o `tsx` ja instalado (devDeps do package.json) — nao precisa de novo dep
- Tipagem TS valida (rode `npx tsc --noEmit` no fim e reporte)
- NAO mudar arquivos de codigo (Athena cobre isso)

## Risco
LOW pra config tweaks. MED pra migrations (criacao de indice unique pode falhar se houver duplicatas — mitigacao acima).

## Entregavel
Crie `scratchpad/agent-poseidon-impl.md`:
- Arquivos modificados/criados
- Conteudo abreviado dos 3 migrations
- Output do `npx tsc --noEmit` (deve passar)
- Riscos a validar manualmente

## Memoria Obsidian
Crie:
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-08_09-35_perf-impl-poseidon.md

## Passo final OBRIGATORIO
Apos aplicar tudo, rode EXATAMENTE:
cmux wait-for --signal done-poseidon-impl-1730983800
