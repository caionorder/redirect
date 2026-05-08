# Migrations

Scripts standalone para criacao de indices MongoDB. Sem framework de migration tracker — executar manualmente, na ordem, uma vez por ambiente.

Pre-requisitos:

- `.env` com `MONGODB_URL` e (opcional) `MONGO_DB_NAME` (default: `admanager`)
- `tsx` ja esta nas devDependencies

## Ordem e comandos

```bash
npx tsx migrations/001-redirects-links-indexes.ts
npx tsx migrations/002-redirects-clicks-count-index.ts
npx tsx migrations/003-broad-clicks-date-index.ts
```

## Indices criados

| Script | Colecao | Indice | Nome | Notas |
| --- | --- | --- | --- | --- |
| 001 | `redirects_links` | `{ domain: 1, url: 1 }` unique | `domain_url_unique` | Verifica duplicatas antes; se houver, cria como nao-unique e loga aviso |
| 001 | `redirects_links` | `{ domain: 1, created_at: -1 }` | `domain_createdAt` | |
| 001 | `redirects_links` | `{ created_at: -1 }` | `createdAt` | |
| 002 | `redirects_clicks` | `{ count: -1 }` | `count_desc` | |
| 003 | `broad_clicks` | `{ date: 1, broad_id: 1 }` | `date_broadId` | Complementa o `{broad_id, date}` unique existente |

Todos com `background: true`.

## Re-executar

`createIndex` e idempotente quando nome e key coincidem — pode rodar varias vezes sem erro. Se precisar trocar key/options, dropar manualmente antes:

```js
db.<colecao>.dropIndex('<nome>')
```
