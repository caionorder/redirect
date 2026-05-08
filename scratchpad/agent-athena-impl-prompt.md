Voce e Athena, frontend-senior-developer. Voce TAMBEM cobre Node.js/Express porque sua jurisdicao inclui .ts/.tsx/.js. Modo: APLICAR mudancas de codigo. Nao commitar. Nao rodar testes. Nao deploy.

## Contexto
Projeto: /Users/caionorder/Dev/redirect (servico de redirect HTTP latency-critical, Node 23, TS, Express, MongoDB, ioredis, cluster mode).

A analise completa esta em scratchpad/agent-hera.md (ja existe, leia para detalhes). Voce vai aplicar a Fase 1 dos itens de codigo do plano scratchpad/PERFORMANCE_PLAN.md.

## Suas mudancas (Fase 1 — itens 1.4, 1.5, 1.6, 1.7, 1.8, 1.14)

### 1.4 — RedirectController singleton (BLOCKER)
Hoje:
- `src/app.ts:97` cria `new RedirectController(db)` (instancia A).
- `src/routes/redirect-route.ts:7` cria OUTRA `new RedirectController(db)` (instancia B).
- Cada instancia tem caches separados, dispara cron, cria indice. → cron duplicado no worker 1.

Fix:
- Editar `src/routes/redirect-route.ts` para receber `controller` injetado em vez de `db`. Trocar a assinatura para `createRedirectRouter(controller: RedirectController)`.
- Em `src/app.ts:97-106`, instanciar `RedirectController` UMA vez e passar para `createRedirectRouter(redirectController)`.
- Confirmar que nenhum outro arquivo instancia `RedirectController` alem do app.ts.

### 1.5 — Mover middlewares pra /api
Em `src/app.ts`, mover de global para `app.use('/api', ...)`:
- `helmet({ contentSecurityPolicy: { directives: { ... } } })` (linhas ~21-31)
- `cors({ origin: '*', credentials: true })` (linhas ~48-53)
- `compression({ level:6, threshold:1024 })` (linhas ~42-45)
- `express.json({ limit: '10mb' })` (linha ~56)
- `express.urlencoded({ extended:true, limit:'10mb' })` (linha ~57)

Estrategia: mantenha `trust proxy`, `etag false`, `cookieParser` (se houver) globais. Crie um router `/api` que aplica os middlewares acima e a partir dele monta as rotas `/api/*` existentes (provavelmente `domain-group-route` e algumas em `/api/process`, `/api/rank` etc.). VERIFIQUE o codigo atual antes — pode haver rotas `/api/...` ja sendo montadas direto. Adapte.

CUIDADO: a rota `iframe` (in-app) provavelmente exige helmet com frameSrc liberado. Se ela nao esta em `/api`, mantenha helmet especifico nela.

### 1.6 — Remover morgan + console.log do hot path
- `src/app.ts:38` — desligar `morgan` em prod (NODE_ENV==='production'). Pode condicionar: `if (process.env.NODE_ENV !== 'production') app.use(morgan('[UTM REQUEST] :method :url'))`. Ou montar morgan so em `/api`.
- `src/controllers/redirect-controller.ts` — remover (ou colocar atras de `if (process.env.DEBUG_REDIRECT==='1')`):
  - linha 1021 `console.log('[DEBUG INAPP]...')`
  - linha 1024 (o `JSON.stringify(inAppRules.map(...))`)
  - linhas 1145, 1150 `console.log('[CLICK RECORDED ...]'...)`
  - linhas 1281, 1286 `console.log('[CLICK RECORDED ...]'...)`
- IMPORTANTE: confirme as linhas com Read antes — podem ter mudado. Use grep `console.log` em redirect-controller.ts e remova os do hot-path (path de request `/`, `/:slug`, `/db`). Mantenha `console.error` e logs de cron/inicializacao.

### 1.7 — INVERTED_LANG_DOMAINS estatico + skip new URL()
Em `src/controllers/redirect-controller.ts`:
- Encontre a constante `invertedLangDomains` (provavelmente perto da linha 1102, dentro do handler).
- Promova para `private static readonly INVERTED_LANG_DOMAINS = new Set([...])` na classe.
- No handler, antes de `new URL(redirectUrl)`, faca check rapido: extraia hostname via substring (`redirectUrl.split('//')[1]?.split('/')[0]?.split('?')[0]`) e teste `RedirectController.INVERTED_LANG_DOMAINS.has(hostname)`. So instancie `new URL(redirectUrl)` se entrar nessa branch.

### 1.8 — Remover dead Redis write `recent:<ip>`
Em `src/controllers/redirect-controller.ts`:
- Linhas 1156 e 1292: remover `await redis.set('recent:'+clientIp, '1', 'EX', 5)` (ou `redis.set('recent:'+clientIp, ..., 'EX', 5)`).
- Confirme via grep que `recent:` nao e LIDO em nenhum lugar do codigo (`grep -rn "recent:" src/`). Se for so write, remover. Se for lido, NAO remover e me avise.

### 1.14 — bulkWrite em incrementMultipleClicks
Em `src/repositories/redirect-click-repository.ts:209-228`:
- Hoje: loop `for ... of` chamando `await this.collection.updateOne({...}, {...}, {upsert:true})` por linkId.
- Fix: trocar por `this.collection.bulkWrite(operations, { ordered: false })` onde `operations` e array de `{ updateOne: { filter, update, upsert: true } }` para cada linkId.
- Manter mesma assinatura externa.

## Restricoes
- NAO commit
- NAO rodar testes (a menos que necessite verificar typing — `npx tsc --noEmit` e ok pra checar build, nao precisa)
- NAO deploy
- Use `grep`/`Read` antes de editar para confirmar linhas exatas (numeros podem ter shift)
- Nao introduza dependencias novas (sem npm install)
- Nao quebre tipagem TS

## Risco
MED. Mudancas afetam hot path. Singleton tem maior risco — verificar que controller e usado consistentemente.

## Entregavel
Crie `scratchpad/agent-athena-impl.md` com:
- Lista exata de arquivos modificados (file:line ranges)
- Resumo do que mudou em cada arquivo
- Quaisquer findings novos que voce descobriu durante a edicao
- Risk flags / pontos a validar manualmente
- Comando para validar build: `cd /Users/caionorder/Dev/redirect && npx tsc --noEmit`

## Memoria Obsidian
Crie:
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-08_09-35_perf-impl-athena.md
com YAML frontmatter (tags: [performance, implementation, code, redirect]), wikilinks pros files modificados.

## Passo final OBRIGATORIO
Apos aplicar tudo + scratchpad + obsidian, rode EXATAMENTE:
cmux wait-for --signal done-athena-impl-1730983800
