Voce e Athena, frontend-senior-developer (cobre Node/TS). Modo: APLICAR. Nao commit. Nao testes externos. Nao deploy.

## Contexto
Bug identificado: rotas Express registradas estaticamente no boot (em `src/app.ts:115-119`) nao podem ser desregistradas em runtime. Quando um slug e renomeado ou deletado, a rota estatica antiga continua respondendo e causa comportamento inconsistente. Ja existe catch-all dinamico (`src/app.ts:124-148`) que funciona para slugs criados pos-boot.

Decisao: remover registros estaticos, usar SO catch-all com versao SYNC do `getActiveSlugs` (sem microtask por request). Isso tambem cobre o item 3.7 do `scratchpad/PERFORMANCE_PLAN.md`.

## Mudancas a aplicar

### 1. `src/services/domain-group-service.ts` — adicionar getters sync

Adicionar dois novos campos privados na classe:
```ts
private activeSlugsArrayCache: string[] = [];
```
(o `cache: Map` ja existe, mas iterar `.keys()` aloca array a cada chamada — vamos memoizar)

Em `refreshCache()` (linha ~65), apos popular `this.cache` e antes do `this.cacheTime = Date.now()`, atualizar o array memoizado:
```ts
this.activeSlugsArrayCache = Array.from(this.cache.keys());
```

Adicionar metodo novo (apos `getActiveSlugs()` na linha ~117):
```ts
/**
 * Versao sincrona de getActiveSlugs. Usa array memoizado.
 * Pre-condicao: cache ja foi populado (refreshCache chamado pelo seed() no boot).
 * Em hot path, evita microtask por request.
 */
getActiveSlugsSync(): string[] {
    return this.activeSlugsArrayCache;
}
```

NAO remover `getActiveSlugs()` async — outros callers podem usar.

### 2. `src/app.ts` — remover loop estatico + refatorar catch-all

Linha ~115-119 (loop de slugs ativos): **DELETAR completo**:
```ts
// DELETAR isto:
try {
    const slugs = await domainGroupService.getActiveSlugs();
    for (const slug of slugs) {
        if (slug === 'main' || slug === 'db') continue;
        console.log(`[ROUTES] Registering route /${slug}`);
        app.get(`/${slug}`, (req, res) => redirectController.redirectByGroup(req, res, slug));
        app.get(`/${slug}/:campaignId`, (req, res) => redirectController.redirectByGroup(req, res, slug));
    }
} catch (error) {
    console.error('[ROUTES] Error registering dynamic routes:', error);
}
```

Linha ~121 (rota estatica `/db/:campaignId`): **MANTER** — `/db` e tratada como caso especial fixo, junto com `/db` na linha ~113.

Linhas ~124-148 (catch-alls `/:param` e `/:param/:campaignId`): refatorar pra usar `getActiveSlugsSync()` em vez de `getActiveSlugs().then(...)`:

```ts
// Catch-all: captura slugs (criados em qualquer momento) + fallback pra grupo main
app.get('/:param', (req, res) => {
    const param = req.params.param;
    const slugs = domainGroupService.getActiveSlugsSync();
    if (slugs.includes(param) && param !== 'main') {
        redirectController.redirectByGroup(req, res, param);
    } else {
        redirectController.redirect(req, res);
    }
});

app.get('/:param/:campaignId', (req, res) => {
    const param = req.params.param;
    const slugs = domainGroupService.getActiveSlugsSync();
    if (slugs.includes(param) && param !== 'main') {
        redirectController.redirectByGroup(req, res, param);
    } else {
        redirectController.redirect(req, res);
    }
});
```

Removeu: Promise/microtask, `.catch()` (cache populado e nao falha — array sempre existe).

### 3. Sanity check
- Verifique se `domainGroupService.seed()` (chamado em `app.ts:63`) sempre chama `refreshCache()` no fim. SIM, confirmei nas linhas 40 e 59 de domain-group-service.ts. OK — `activeSlugsArrayCache` sempre estara populado quando rotas comecam a receber requests.
- Verifique se ha outros call sites de `getActiveSlugs()` async que poderiam migrar pra sync. Encontre via grep:
  ```
  grep -rn "getActiveSlugs" src/
  ```
  - `redirect-controller.ts:172` em `executeAllGroups` — cron, nao hot path. Manter async (e ok).
  - `redirect-controller.ts:567` em `process` — admin endpoint. Manter async.
  - `app.ts` — sera o unico usando sync apos a refatoracao.

### 4. Validar
```bash
cd /Users/caionorder/Dev/redirect
npx tsc --noEmit
```
Deve retornar EXIT=0. Se houver erro, REPORT no scratchpad e nao force solucao agressiva.

## Restricoes
- NAO commit. NAO push.
- NAO mexer em controllers/services alem do explicitamente listado.
- NAO mudar logica de `redirect()` ou `redirectByGroup()`.
- NAO criar arquivos novos (so editar 2: app.ts e domain-group-service.ts).
- TS build deve continuar limpo.
- Nao adicionar dependencias.

## Risco
LOW. Catch-all ja era o que servia slugs novos pos-boot. Estamos so consolidando + tornando sync.

Edge case que merece flag mental: e se uma request chega ANTES do `seed()` terminar? Nao acontece pq `app.use('/api', apiRouter)` e `app.get('/', ...)` sao registrados DEPOIS do `await domainGroupService.seed()` (linha 63). Listen comeca em `index.ts` apos `createApp()` retornar. Ordem garantida.

## Entregavel
`scratchpad/agent-athena-routing.md`:
- Lista de mudancas (file:line)
- Diff conceitual antes/depois
- Output do `npx tsc --noEmit`
- Edge cases revisados
- Confirmacao que nada alem dos 2 arquivos foi tocado

## Memoria Obsidian
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-08_11-10_routing-fix-athena.md
tags: [routing, bug-fix, performance, redirect]

## Passo final OBRIGATORIO
Apos aplicar + tsc passar + scratchpad + obsidian, rode EXATAMENTE:
cmux wait-for --signal done-athena-routing-1730988600
