# Athena — Routing Fix (Static Routes Removal)

**Data:** 2026-05-08
**Risco:** LOW
**Sinal:** done-athena-routing-1730988600

## Contexto
Bug: rotas Express registradas estaticamente no boot (`app.ts:115-126`) ficavam no router mesmo apos rename/delete do slug, causando comportamento inconsistente. Catch-all dinamico ja existia para slugs novos pos-boot. Decisao: remover registro estatico, manter SO catch-all com versao sync para evitar microtask por request (item 3.7 do PERFORMANCE_PLAN.md).

## Arquivos modificados (2)

### 1. `src/services/domain-group-service.ts`

- **Linha 11 (novo campo):** `private activeSlugsArrayCache: string[] = [];`
- **Linha 75 (refreshCache):** apos popular `allGroupsCache` e antes de setar `cacheTime`, adicionado `this.activeSlugsArrayCache = Array.from(this.cache.keys());`
- **Linhas 122-130 (novo metodo):** `getActiveSlugsSync(): string[]` que retorna o array memoizado.

`getActiveSlugs()` async permanece intacto (callers no controller ainda dependem dele).

### 2. `src/app.ts`

- **Linhas 115-126 (DELETADO):** loop estatico `for (const slug of slugs) { app.get(...) }`. Removido completamente. Tambem removido o try/catch que envelopava o loop e o `console.log('[ROUTES] Registering route /...')`.
- **Linha 113 (MANTIDO):** `app.get('/db', ...)` — caso especial fixo.
- **Linha 117 (atual, ex-129) (MANTIDO):** `app.get('/db/:campaignId', ...)` — caso especial fixo.
- **Linhas 119-138 (catch-alls refatorados):** removido `getActiveSlugs().then(...).catch(...)`, substituido por chamada sincrona `getActiveSlugsSync()`. Sem promise, sem microtask, sem `.catch()` (cache nunca falha — array sempre existe apos seed).

## Diff conceitual

ANTES (boot, hot path):
```
boot: registrar /:slug e /:slug/:campaignId estaticamente para cada slug existente
req: catch-all faz await getActiveSlugs() (microtask) -> redirect
```

DEPOIS (boot, hot path):
```
boot: nada de loop. Apenas /, /db, /db/:campaignId fixos.
req: catch-all le getActiveSlugsSync() do array memoizado -> redirect (zero microtask)
```

Beneficio:
1. Rename/delete de slug agora reflete imediatamente no roteador (refreshCache atualiza o array).
2. Hot path nao paga uma Promise/microtask por request.

## TypeScript Check

```
$ npx tsc --noEmit
EXIT=0
```

## Edge cases revisados

1. **Race seed vs request:** `seed()` (`app.ts:63`) e `await`-ado antes de qualquer `app.use('/api', ...)` ou rota raiz. `seed()` chama `refreshCache()` em ambos os branches (linhas 40 e 59). Listen comeca em `index.ts` apos `createApp()` resolver. Garantia: `activeSlugsArrayCache` sempre populado quando primeiro request chega.

2. **Refresh durante request:** `refreshCache()` reescreve `activeSlugsArrayCache` com `Array.from(...)`. Reads concorrentes leem ou o array antigo ou o novo (referencia atomica). Sem mutacao in-place do array antigo, sem inconsistencia parcial.

3. **Cache vazio (DB error):** se `repository.findActiveGroups()` falhar, o catch em `refreshCache` (linha 76-78) loga erro mas nao limpa o cache existente. `activeSlugsArrayCache` mantem ultimo valor consistente.

4. **Slug "main":** filtro `param !== 'main'` mantido em ambos catch-alls. `/main` continua caindo no `redirect()` default (grupo main), comportamento identico ao anterior.

5. **Outros call sites de `getActiveSlugs`:** `redirect-controller.ts:172` (executeAllGroups, cron) e `:567` (process, admin endpoint) — ambos async, fora de hot path. Mantidos como estao (prompt explicitamente pediu).

## Confirmacao de escopo

```
$ git status --short
 M src/app.ts
 M src/services/domain-group-service.ts
```
+ scratchpad e memoria Obsidian (nao versionados como codigo).

Apenas os 2 arquivos especificados foram alterados. Nenhum controller, route, repository ou config foi tocado. Logica de `redirect()` e `redirectByGroup()` intacta.

## Restricoes respeitadas
- [x] Sem commit
- [x] Sem push
- [x] Sem testes (Themis nao foi acionada)
- [x] Sem deploy
- [x] Sem novos arquivos de codigo
- [x] Sem novas dependencias
- [x] TS build limpo
