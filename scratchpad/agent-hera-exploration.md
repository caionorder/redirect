# Review Hera — exploração 10% (`feat/exploration-10pct`)

> **Round 2 (re-review pós-fixes): APROVADO**, com uma precondição obrigatória de staging e 4 follow-ups MINOR. Ver seção [Re-review](#re-review--round-2) no fim do arquivo. A seção abaixo é o registro do round 1.

---

## Round 1

Escopo: `git diff` do working tree contra HEAD. Arquivo de código: `src/controllers/redirect-controller.ts` (+200/-33). Também alterado: `scratchpad/agent-athena.md`.

**Veredito: APROVADO COM RESSALVAS.** Nenhum blocker. A aritmética de índices está correta e foi verificada de forma independente. Os itens IMPORTANT abaixo devem ser corrigidos ou explicitamente aceitos pelo produto antes do merge.

## Verificação independente da aritmética

Não confiei na simulação do implementador; refiz com casos que o script original não cobria (`rankLen` não múltiplo de 10, `rankLen < 10`, pool vazio, offset de counter arbitrário):

```
rank=50  pool=300 N=100000 expl=10000 rankMin=1800 rankMax=1800 rankZero=0 poolZero=0
rank=47  pool=300 N=100000 expl=10000 rankMin=1914 rankMax=1915 rankZero=0 poolZero=0
rank=7   pool=300 N=10000  expl=1000  rankMin=1285 rankMax=1286 rankZero=0 poolZero=0
rank=3   pool=5   N=10000  expl=1000  rankMin=3000 rankMax=3000 rankZero=0 poolZero=0
rank=1   pool=1   N=1000   expl=100   rankMin=900  rankMax=900  rankZero=0 poolZero=0
rank=50  pool=0   N=10000  expl=0     rankMin=200  rankMax=200  rankZero=0
rank=10  pool=10  N=10000  expl=1000  rankMin=900  rankMax=900  rankZero=0 poolZero=0
offset=7 (counter em curso)           expl=1000  rankMin=180  rankMax=180  rankZero=0 poolZero=0
```

`rankCounter = visitIndex - Math.floor((visitIndex+1)/MOD)` produz inteiros consecutivos sobre os requests não-exploração, então `rankCounter % len` é um ciclo perfeito para qualquer `len`, múltiplo de 10 ou não. Correção de starvation confirmada. Os dois handlers usam expressões idênticas — sem divergência.

`npm run build` → exit 0, sem erros. Scan de secrets no diff → nada.

## IMPORTANT

### 1. `redirect-controller.ts:335,359` — domínios com WP quebrado são buscados DUAS vezes por ciclo
O comentário em `:332-333` afirma "nenhuma chamada WP extra". Verdade só para domínios saudáveis. `fetchAllValidPosts` (`:585-592`, comportamento introduzido em b10cd19) **não persiste no cache** falha sem fallback — de propósito, para re-tentar no próximo ciclo. Como `buildExplorationPool` chama `fetchAllValidPosts` de novo com a mesma lista, esses domínios voltam a `missingDomains` e sofrem `fetchDomainsFromApi` completo **no mesmo ciclo**.
- Impacto: dobra a carga contra hosts WP já erroando; cada domínio caído custa 2 endpoints × `AbortSignal.timeout(10000)` (`:437`), agora pagos duas vezes; estende a duração do cron. Anula parcialmente a intenção de b10cd19 (re-tentar no próximo ciclo, não neste).
- Recomendação: passar o `validPostsMap` já resolvido por `validateRanking` como parâmetro para `buildExplorationPool`, em vez de refazer a chamada. Ajustar o comentário `:332-333`, que hoje é falso.

### 2. `redirect-controller.ts:1332-1349` e `1515-1531` — exploração quebra a garantia do bestRpsMode
`getBestRpsLink` (`:825`) existe para não repetir domínio ao mesmo IP dentro da hora, marcando o domínio em `visitor:*` via `sadd`. O branch de exploração pula isso inteiro: não consulta e não marca `visitedDomains`.
- Impacto: em grupos com `bestRpsMode`, 10% das requests podem mandar o usuário a um domínio já visto na hora, e o domínio explorado não entra no set — o bestRps pode mandar o mesmo usuário para lá de novo depois. Como a fatia é decidida por counter global (não por usuário), qualquer usuário tem 10% de chance por request de furar a regra.
- Recomendação: decisão explícita de produto. Opção conservadora: chamar o mesmo `sadd`/TTL de `:850-862` no branch de exploração, para o rodízio seguir coerente. Precedente pronto: `addVisitedDomain` (`:799`) já implementa exatamente isso e hoje está sem nenhum caller.

### 3. `redirect-controller.ts:1328,1511` — `getGlobalVisitIndex` saiu para fora do branch de modo: +1 round-trip Redis por request em grupos bestRps
Antes, grupos com `bestRpsMode` nunca chamavam `getGlobalVisitIndex`. Agora todo request paga um `INCR` (`:784`) adicional, no hot path do serviço de maior volume.
- Impacto: latência e QPS no Redis proporcionais ao tráfego total dos grupos bestRps, não a 10% dele.
- Recomendação: se o custo pesar, decidir a fatia sem counter dedicado (ex.: hash do IP+minuto) ou aceitar conscientemente e registrar. É intrínseco ao desenho atual — precisa ser escolha, não efeito colateral.

### 4. `redirect-controller.ts:334` — universo de exploração limitado aos domínios que já monetizam
`uniqueDomains` vem de `limitedRanking`, ou seja, apenas domínios com dado GAM de hoje e ≥100 impressões. Um domínio novo ou sem receita hoje recebe zero exploração a nível de post — só entra no ranking como `/random` via `interleaveByDomain` (`:659`).
- Impacto: o loop de retroalimentação é quebrado no eixo *post*, mas continua fechado no eixo *domínio* — exatamente a classe de problema que motivou a mudança.
- Recomendação: considerar `groupDomains` como universo. Tradeoff real a decidir: domínios fora do cache de validação forçariam chamadas WP no cron (ver item 1). Se ficar como está, documentar a limitação.

### 5. `redirect-click-repository.ts:238-292` — clicks de `explore_main_*` não são contabilizados em `/api/rank`
A extração de sufixo no `$addFields` só trata `parts[1] === 'db'`; qualquer outro slug cai no `else` e o sufixo vira `main_<domain>_<postId>` em vez de `<domain>_<postId>`. O `$match` (`:238`) casa o documento, mas o `$group` o joga num bucket que `getRank` (`:1621`) nunca lê.
- Impacto: reporting apenas — o ranking é dirigido por eCPM do GAM, não por clicks. Mas quando um post graduado pela exploração entra no ranking, o histórico de clicks dele fica invisível. Bug pré-existente para `bestrps_*` e `rank<i>_<slug>_*`; a mudança o estende a `explore_*`.
- Recomendação: fora do escopo deste diff, mas vale um follow-up — trocar o `$let/$cond` hardcoded em `'db'` por um `$regexFind` que corte tudo antes do último par `_<domain>_<postId>`.

### 6. Coverage gap — nenhum teste versionado
`package.json:test` é `echo "Error: no test specified" && exit 1`. Não existe infra de teste no repo. A verificação da aritmética (a parte não-trivial do diff) mora num script fora do repositório, em `/private/tmp/.../verify-exploration.ts`, que ninguém vai rodar de novo.
- Impacto: três fórmulas de índice interdependentes (`isExplorationRequest`, `rankCounter`, `poolIdx`) duplicadas em dois handlers, sem nenhuma rede de segurança. Uma futura mudança em `EXPLORATION_MOD` reintroduz starvation silenciosamente.
- Recomendação: extrair a decisão de índice para uma função pura e versionar um teste mínimo (`node:test` já vem no runtime, zero dependência nova) cobrindo os casos verificados acima.

## MINOR

- `redirect-controller.ts:786-788` + `:1333,1516` — o counter tem TTL de 1h, então `Math.floor(visitIndex/10)` reinicia em 0 a cada hora. Um slug precisa de ≥3000 requests/hora para alcançar os 300 itens do pool. Medido: a 1000 req/h, **200 dos 300 slots nunca são servidos**; a 3000 req/h, cobertura completa. Como `domainOrder` (`:391-393`) é determinístico, a cauda morta é sempre dos mesmos domínios (os mais representados no topRanking). Mitigado em parte pelo re-shuffle a cada 15 min. Recomendação: se algum grupo é de baixo tráfego, dimensionar `CAP` por slug ou derivar `poolIdx` de algo que não reinicie de hora em hora.
- `redirect-controller.ts:376-383` — Fisher-Yates completo sobre `candidates` antes de `slice(0, 30)`. `result.ids` é o catálogo WP inteiro (paginação sem teto, `:432`), então isso é O(n) em alocação e swaps por domínio por ciclo, para aproveitar 30 itens. Recomendação: shuffle parcial (30 swaps) ou reservoir sampling.
- `redirect-controller.ts:336-344` — `buildExplorationPool` roda por completo mesmo com `this.redisClient` nulo, e o resultado é descartado. Guardar antes da chamada.
- `redirect-controller.ts:337-342` — `await redisClient.set` sem try/catch. Falha de Redis aqui propaga; `executeAllGroups` (`:208`) captura por slug, mas `/api/process?slug=` (`:735`) devolve 500 mesmo com o ranking já salvo em `:316`. O ranking em si está protegido pela ordem (salvo antes do pool) — isso está certo.
- `redirect-controller.ts:1326-1363` vs `1509-1545` — bloco de ~30 linhas duplicado verbatim entre os dois handlers, diferindo só no formato do `linkId`. É o padrão pré-existente do arquivo, mas agora carrega a aritmética de índices em duplicata. Recomendação: extrair um `pickLink(slug, ranking, clientIp, groupDomains)`.

## NIT

- `redirect-controller.ts:396` (`CAP = 300`) e `:385` (`slice(0, 30)`) — números mágicos inline, enquanto `EXPLORATION_MOD` é campo de classe. Padronizar.
- `redirect-controller.ts:111` — o comentário fixa "(10%)"; diverge se `EXPLORATION_MOD` mudar. Descrever como `1/N`.
- `redirect-controller.ts:1351-1354,1533-1536` — o comentário justifica a correção com "ranking.length é múltiplo de MOD", verdade só quando o ranking está cheio em 50. A fórmula está certa para qualquer tamanho; a justificativa é mais estreita que o fix.
- `scratchpad/agent-athena.md` foi sobrescrito, apagando o registro da task anterior (inversão de idioma) num arquivo versionado. Preferir `agent-athena-<task>.md`.

## Padrões observados

Positivo: ordem correta em `executeProcessForGroup` (ranking persistido antes do pool, então falha na feature nova não derruba a feature antiga); `getExplorationPoolForGroup` espelha fielmente `getBestLinksMapForGroup`, inclusive no fallback para cache em memória; serving 100% Redis-backed, correto para cluster (cron só no worker 1, `:154`); fallback transparente quando o pool está vazio; nenhuma mudança não relacionada no diff.

Recorrente a vigiar: o arquivo já tinha os dois handlers em copy-paste, e cada feature nova multiplica a superfície de divergência. A próxima mudança nesse bloco deveria vir com a extração.

---

# Re-review — round 2

Escopo: delta desde o round 1, mesma branch, working tree. Alterados: `src/controllers/redirect-controller.ts`, `package.json`; mais dois arquivos **untracked**: `src/utils/exploration-math.ts` e `src/utils/exploration-math.test.ts`.

**Veredito: APROVADO.** Os cinco IMPORTANT do round 1 foram resolvidos de fato, sem meia-solução. Nenhum problema novo de correção. Há uma precondição obrigatória antes do commit (staging) e 4 follow-ups MINOR.

## Verificação do que foi corrigido

| Finding | Status | Evidência |
|---|---|---|
| F1 (double fetch WP) | Resolvido | `validateRanking` (`:731-733,772`) devolve `{ranking, validPostsMap}`; `buildExplorationPool` recebe o mapa. `extraDomains` exclui **tudo** que está em `domainsValidatedThisCycle`, inclusive os que falharam — sem refetch no mesmo ciclo, respeitando a política de b10cd19. O comentário `:352-359` agora descreve o custo real. |
| F2 (universo de domínios) | Resolvido | Universo agora é `groupDomains` (`:341,388`). Ordem preservada: o ranking salvo em `:316` continua **antes** do bloco do pool, inserido depois do log do top-5. |
| F3 (invariante bestRps) | Resolvido | `groupConfig` movido para antes da decisão; `addVisitedDomain(clientIp, slug, domain)` no branch de exploração. A chave bate: `getVisitorKey(ip, slug)` é exatamente a que `getBestRpsLink` (`:831`) lê. Alargar o tipo `'main'\|'db'` → `string` é seguro (`getVisitorKey` já aceitava `string`; a função tinha zero callers). |
| F4 (testes) | Resolvido | `src/utils/exploration-math.ts` com 4 funções puras; os dois handlers as chamam de forma **idêntica** (diff linha-a-linha dos dois blocos: só variam slug e formato de `linkId`, nenhuma divergência aritmética). O teste cobre exatamente o que medi no round 1: rankLens `[50,47,10,7,3,1]`, poolLens `[300,37,10,5,1]`, offset de counter, pool vazio, e o caso combinado. |
| M1/M2/M3/N1/N2/N3 | Resolvidos | Guard de Redis envolve o bloco inteiro; try/catch no `set`; shuffle parcial correto (selection sampling — `j = i + rand(n-i)` dá amostra uniforme sem viés); constantes nomeadas; docstring de `rankIndex` agora afirma corretamente que a fórmula vale para QUALQUER `rankingLength` (era meu N3). |
| Finding 3 (INCR extra) | Aceito | Tradeoff registrado em comentário nos dois handlers. |
| Finding 5 (sufixo `/api/rank`) | Follow-up | Não tocado, como combinado. |

Rodados: `npm run build` exit 0; `npm test` 6/6 pass; `tsconfig.exclude` contém `**/*.test.ts`, então o teste **não** vai para `dist/`.

Verifiquei também a generalização que a docstring do módulo promete mas o teste não cobre — `mod ∈ {2,3,5,10,20,100}` × `rankLen ∈ {50,47,7,1}` × `poolLen ∈ {300,37,5,1}`, 300k iterações cada: fração de exploração exata em `1/mod`, zero slots famintos, `max-min ≤ 1` em todos. A fórmula generaliza; é lacuna de teste, não bug.

## MINOR (follow-ups, não bloqueiam)

- `redirect-controller.ts:339-353` — o try/catch adicionado por M2 cobre só o `redisClient.set`, mas F2 moveu I/O de rede (`fetchAllValidPosts` dos domínios extras) para dentro de `buildExplorationPool`, que ficou **fora** do try. Hoje não explode (`fetchDomainsFromApi` usa `Promise.allSettled`, nunca rejeita), então é lacuna latente e não bug vivo: `executeAllGroups:208` captura por slug e o ranking já está salvo, mas `/api/process?slug=` devolveria 500 sobre um ranking que deu certo. Estender o try para envolver a chamada.
- Custo operacional novo, introduzido por F2: um domínio configurado em `groupDomains`, sem dado GAM e com WP fora do ar, passa a ser buscado **a cada ciclo de 15 min** (falha não é cacheada, por design de b10cd19) — antes nunca era tocado. Até 2 endpoints × 10s de timeout, e `executeAllGroups` itera slugs em série, então na pior hipótese o ciclo cresce ~20s por grupo com domínio extra morto, somados aos ~20s que `validateRanking` já podia custar. Não está errado — é o preço de expandir o universo —, mas vale acompanhar a duração do cron nos logs após o deploy.
- `package.json:29` — `tsx --test src/**/*.test.ts` sem aspas: quem expande é o `sh` do npm, e `**` **não** é recursivo em sh. Verificado: casa exatamente um nível de diretório. Funciona hoje só porque o arquivo está em `src/utils/`. Um futuro `src/foo.test.ts` (nível zero) ou `src/a/b/c.test.ts` (dois níveis) seria **silenciosamente pulado** com suíte verde — o pior modo de falha para um gate de teste. Passar o padrão entre aspas e deixar tsx/node expandir.
- A suíte não é gate de merge: o `Jenkinsfile` não tem stage de teste (buildx → checkout → env → docker build/push → deploy) e o `Dockerfile:22-24` roda `npm run build` mas não `npm test`. F4 entregou o teste, não a exigência. Fix concreto: acrescentar `npm test` ao `RUN` de build do Dockerfile, para teste quebrado quebrar a imagem.

## NIT

- Todos os testes fixam `MOD = 10`, embora a docstring do módulo diga proteger contra mudança de `EXPLORATION_MOD`. Parametrizar sobre alguns mods fecharia a lacuna (a propriedade vale — verifiquei acima).
- `exploration-math.ts:22` — `explorationPoolIndex` com `poolLength = 0` devolve NaN (`x % 0`); idem `rankIndex` com `rankingLength = 0`. Inalcançável via `decideServingSource` (guardado) e via os dois handlers, mas as funções são exportadas.

## Precondição obrigatória antes do commit

`src/utils/exploration-math.ts` e `src/utils/exploration-math.test.ts` estão **untracked**. Um `git commit -am` comitaria um controller importando arquivo inexistente. O `tsc` do Docker build quebraria (Jenkins pega no stage de build, não chega em produção), mas o commit precisa de `git add src/utils/` explícito. Decidir também sobre `scratchpad/agent-hera-exploration.md` (untracked), e notar que `scratchpad/agent-athena.md` segue sobrescrito, apagando o registro da task anterior — NIT do round 1, não endereçado.
