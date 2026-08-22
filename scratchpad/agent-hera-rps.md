# Code review — RPS ranking (bestRpsMode) — Hera, 2026-08-22

## Escopo revisado

Diff não-commitado em `feat/rps-ranking-bestrps`:

- `src/controllers/redirect-controller.ts` (modificado, +80/-15)
- `src/services/pageview-service.ts` (modificado, +82)
- `docs/openapi.yaml` (modificado, +12/-6)
- `src/utils/rps-ranking.ts` (novo, 40 linhas)
- `src/utils/rps-ranking.test.ts` (novo, 146 linhas — 10 testes de Athena + 7 de Argus)

Contexto lido: `scratchpad/agent-athena-rps.md`, `scratchpad/agent-argus-rps.md`.

## Veredito

**APROVADO COM RESSALVAS** — nenhum BLOCKER, nenhum CRITICAL. O commit pode seguir.

5 findings IMPORTANT (1 deles é uma quebra real, ainda que benigna, de um invariante que o
usuário declarou explicitamente — precisa de aceite consciente, não de código novo),
7 MINOR, 3 INFO.

## Verificação independente dos invariantes exigidos

| # | Invariante | Resultado |
|---|-----------|-----------|
| 1 | Grupos não-bestRpsMode bit-a-bit iguais | **VIOLADO em empate de eCPM** — ver IMP-1 (reproduzido) |
| 2 | Nenhum re-sort desfaz a ordem RPS | **OK** — `validateRanking` usa `.filter` (preserva ordem); `interleaveByDomain` preserva ordem intra-domínio; o sort eCPM defensivo roda ANTES do bloco RPS |
| 3 | Ordenação distingue `rps null` de `rps 0` real | **OK** — `sortRpsWithEcpmFallback` particiona por `!== null` e só depois `entry.ref.rps = entry.rps ?? 0` coage para número. Coberto por teste (`revenue 0 com uniques válido é RPS 0 válido`) |
| 4 | Falha total da API ⇒ ranking == eCPM, sem exceção, sem esvaziar | **OK** — `fetchUniqueVisitors` tem try/catch total; `fetchBulkUniques` usa `Promise.allSettled`; todos `undefined` ⇒ todos `rps null` ⇒ ordem eCPM pura (coberto pelo teste `todos-null produz a mesma ordem do ranking eCPM puro`). `executeAllGroups` (`redirect-controller.ts:222-228`) mantém try/catch por grupo — um throw em `main` não impede os demais |
| 5 | Custo/latência do ciclo | **RISCO ACEITÁVEL, mas sem guarda** — ver IMP-4 |
| 6 | `getBestRpsLink`, `bestrps_*`, pool de exploração intocados | **OK** — `git diff` não toca nenhum deles. Só a docstring ficou desatualizada (MIN-3) |
| 7 | Cobertura de testes | **BOA nas funções puras**, lacuna na única função cujo comportamento mudou — ver IMP-2 |
| 8 | `docs/openapi.yaml` coerente | **QUASE** — ver MIN-4, MIN-5 |

Comandos rodados por mim (resultados reais):

```
npm run build   → tsc, saída limpa, 0 erros
npm test        → # tests 29 / # pass 29 / # fail 0
node -e "js-yaml load docs/openapi.yaml" → YAML OK
```

---

## IMPORTANT

### IMP-1 — `interleaveByDomain` muda a ordem dos domínios em empate de eCPM (quebra o invariante "grupos não-bestRpsMode intocados")

`src/controllers/redirect-controller.ts:749-763`

O código antigo ordenava os domínios por `domainGroups.get(d)![0].ecpm` desc. Comparador de
uma chave só + sort estável do V8 ⇒ **empate de eCPM era desempatado pela ordem de
`allDomains`** (a ordem da lista de domínios do grupo no Mongo). O código novo ordena pela
posição da primeira ocorrência em `ranking`, cujo desempate é `revenue desc`. São critérios
de desempate diferentes.

Reproduzido isoladamente (ranking já em `(ecpm desc, revenue desc)`, `allDomains =
['a.com','b.com','c.com']`, `b.com` e `a.com` empatados em eCPM 5.00 com revenue 90 e 10):

```
OLD domain order: a.com , b.com , c.com
NEW domain order: b.com , a.com , c.com
IDENTICAL? false
```

**Impacto:** a ordem dos domínios no interleave define quem é `ranking[0]`, e
`getBestRpsLink` serve `ranking[0]` para todo IP que ainda não visitou nenhum domínio na
hora. Ou seja: muda o link efetivamente servido para visitante novo, **em grupos que não
pediram nenhuma mudança** (ex.: `db`). Não é raro: o próprio código comenta que "o eCPM chega
arredondado a 2 casas" (é por isso que `revenue` já é desempate item-a-item) — empate entre os
tops de dois domínios é plausível.

Vale dizer que o comportamento novo é **melhor** (determinístico e coerente com a ordenação
dos itens; o antigo desempatava por ordem arbitrária de cadastro). Não há regressão de
correção. Mas o usuário pediu equivalência bit-a-bit, então isto precisa de aceite explícito.

**Recomendação:** aceitar conscientemente e registrar na mensagem do commit / PR
("`interleaveByDomain` passa a desempatar ordem de domínio por revenue em vez de ordem de
cadastro"). Se equivalência estrita for obrigatória, a alternativa é manter dois comparadores
(eCPM puro no modo antigo, índice no modo RPS) — mas isso reintroduz o acoplamento ao critério
que a generalização acabou de remover, e eu não recomendo.

### IMP-2 — `interleaveByDomain` mudou e continua sem nenhum teste

`src/controllers/redirect-controller.ts:739-780`

É a única função cujo comportamento muda para **todos** os grupos (IMP-1), e é a única peça da
mudança sem cobertura. `rps-ranking.ts` foi corretamente extraído para util puro e testado
(29/29); `interleaveByDomain` continua método privado do controller, validado só por leitura
de código (o próprio Athena registra isso como risco no scratchpad).

**Impacto:** a regressão mais provável de todo o diff é justamente a que nenhum teste pegaria.

**Recomendação:** extrair para `src/utils/interleave-by-domain.ts` como função pura
(`(ranking, allDomains) => RankedLinksList`) e cobrir 4 casos: round-robin básico, domínios sem
dados entrando como `/random` no fim, empate de eCPM entre domínios (fixando o novo
comportamento de IMP-1), e ordem RPS preservada. Precedente no próprio diff:
`src/utils/rps-ranking.ts` + `.test.ts`.

### IMP-3 — Uniques são buscados ANTES da validação WP: até ~160 chamadas HTTP, parte delas para posts que serão descartados

`src/controllers/redirect-controller.ts:341-346` (fetch) vs `:367` (`validateRanking`)

`fetchBulkUniques` roda sobre `limitedRanking`, que ainda contém posts inexistentes no
WordPress. Esses posts são removidos logo em seguida por `validateRanking` — a chamada de
pageview foi paga à toa.

**Impacto:** custo e latência desnecessários no caminho crítico do cron, proporcionais à taxa
de posts inválidos (que o log `[WP-VALIDATE]` já mostra ser não-trivial em alguns ciclos).

**Recomendação:** mover o bloco RPS para **depois** de `validateRanking` e antes de
`interleaveByDomain`, ordenando `validatedRanking` em vez de `limitedRanking`. Os invariantes
2 e 4 continuam valendo (nada re-ordena entre `validateRanking` e o interleave), e o
`domainsValidatedThisCycle` do pool de exploração (`:405`) continua lendo `limitedRanking`, que
não seria mais mutado — comportamento idêntico.

### IMP-4 — Ciclo do cron ficou mais longo e não há guarda contra sobreposição

`src/controllers/redirect-controller.ts:205` + `src/services/pageview-service.ts:142`

Pior caso do grupo `main`: 16 domínios × 10 itens = 160 chamadas, concorrência 3 ⇒ 54 lotes
sequenciais × timeout 3s ≈ **2,7 min só de pageviews**, somados à validação WP e aos demais
grupos. `cron.schedule('*/15 * * * *', ...)` é chamado sem options, e verifiquei em
`node_modules/node-cron/dist/cjs/scheduler/runner.js:35` que **`noOverlap` tem default
`false`** — se um ciclo passar de 15 min, o próximo dispara por cima, dobrando a carga na API
de pageviews e criando escritas concorrentes na mesma chave Redis.

A margem hoje ainda é confortável (o TTL de 1h do Redis, 4 ciclos, não corre risco), mas ela
encolheu materialmente e não existe rede de proteção.

**Recomendação:** duas mudanças baratas e independentes — (a) passar
`{ noOverlap: true }` em `cron.schedule`; (b) subir a concorrência de `fetchBulkUniques` de 3
para ~8 na chamada do controller (o parâmetro já é injetável; 3 era o número herdado de
`fetchBulkPageviews`, que nunca rodou em produção — ver MIN-6), derrubando o pior caso para
~60s.

### IMP-5 — Piso de 10 uniques é estatisticamente fraco para um estimador de razão, e a partição "RPS válido primeiro" dá prioridade absoluta a amostras minúsculas

`src/controllers/redirect-controller.ts:128-130`, `src/utils/rps-ranking.ts:32-40`

`sortRpsWithEcpmFallback` coloca **todo** item com RPS válido antes de **todo** item sem RPS,
independentemente de eCPM. Combinado com `MIN_UNIQUES_FOR_RPS = 10`, um post com 10 uniques e
um clique de sorte (RPS 0,20) fica acima de um post com 9 uniques e eCPM 30 — e acima de um
post com 5.000 uniques e RPS 0,01. Como todo item de `limitedRanking` já passou pelo piso de
100 impressões, a faixa 10-30 uniques é habitada e vai dominar o topo.

**Impacto:** o topo do ranking tende a ser capturado por posts de cauda com RPS ruidoso —
exatamente o tipo de efeito que degrada receita sem aparecer como bug. É risco de produto, não
de código, e o desenho foi aprovado pelo usuário; registro para decisão informada.

**Recomendação:** subir `MIN_UNIQUES_FOR_RPS` para 50-100 antes de confiar no ranking, ou
aplicar encolhimento bayesiano (`(revenue + k·médiaRPS) / (uniques + k)`) para que amostras
pequenas regridam à média. No mínimo: acompanhar o log `[CRON-MAIN] RPS mode:` nos primeiros
ciclos e comparar a distribuição de uniques dos itens que sobem ao topo.

---

## MINOR

### MIN-1 — Docstring de `computeRps` promete mais do que o código entrega, e o guard deixa divisão por zero acessível

`src/utils/rps-ranking.ts:11-18`

A docstring diz "null se uniques for indefinido, **0**, ou menor que minUniques". O código só
testa `uniques === undefined || uniques < minUniques` — `0` só retorna null porque
`0 < 10`. Com `minUniques = 0` (chamada futura, ou reuso do util), `computeRps(x, 0, 0)`
retorna `Infinity`/`NaN` em vez de null. É util puro exportado; o contrato deveria valer sozinho.

**Recomendação:** trocar o guard por `uniques === undefined || uniques <= 0 || uniques < minUniques`.

### MIN-2 — `revenue` NaN vira "RPS válido"

`src/utils/rps-ranking.ts:15-18`

Confirmado o finding de Argus. `uniques` já é blindado por `Number.isFinite` em
`fetchUniqueVisitors`, mas `revenue` vem do ranking eCPM sem guard equivalente
(`redirect-controller.ts:296`: `Number(item.revenue || 0)` aceita NaN de dado sujo). Um `rps`
NaN passa o filtro `!== null`, entra no bucket `withRps` e sua posição final fica arbitrária
(comparações com NaN devolvem NaN, que o engine trata como "não trocar"). Sem exceção, sem item
perdido — só posição indefinida. Documentado por 2 testes.

**Recomendação:** adicionar `!Number.isFinite(revenue)` ao guard de `computeRps`, retornando
null (cai no fallback eCPM).

### MIN-3 — Docstring de `getBestRpsLink` ficou desatualizada

`src/controllers/redirect-controller.ts:919-926`

Continua dizendo "round 0 holds the best-**eCPM** link of each domain" e "serves the
highest-**eCPM** link of each domain". Em grupos `bestRpsMode` agora é o melhor link por RPS.
O diff atualizou a docstring de `interleaveByDomain` mas não esta, que é a leitora da ordem.

**Recomendação:** espelhar a redação usada em `interleaveByDomain` ("melhor item do domínio
segundo o critério ativo").

### MIN-4 — Cabeçalho de `executeProcessForGroup` e descrição do `RankedLink` ainda dizem "ranking eCPM"

`src/controllers/redirect-controller.ts:231` ("cria ranking global por eCPM"),
`docs/openapi.yaml:1126` ("Item do ranking eCPM").

O diff atualizou só a frase sobre `uniqueVisitors`/`rps`; a frase de abertura, que é a que se lê
primeiro, continua afirmando eCPM incondicionalmente.

**Recomendação:** "ranking global por eCPM (ou por RPS em grupos `bestRpsMode`)".

### MIN-5 — openapi não documenta que `uniqueVisitors: 0` também significa "falha da API"

`docs/openapi.yaml:1133-1137`

A descrição cobre "0 nos demais grupos", mas em grupo `bestRpsMode` o valor 0 tem três
significados distintos: post com 0 visitas, chamada de pageview falhou/timeout, e grupo sem a
flag. Consumidor externo não consegue separar.

**Recomendação:** acrescentar "(0 também quando a chamada à API de pageviews falhou neste
ciclo)". Se algum consumidor precisar distinguir de verdade, aí sim justifica um campo
`rpsValid` — hoje não há consumidor, então documentar basta.

### MIN-6 — `fetchPageviews`/`fetchBulkPageviews` são código morto, e `fetchBulkUniques` duplicou ~30 linhas deles

`src/services/pageview-service.ts:38-100` vs `:142-171`

`grep -rn "fetchBulkPageviews\|fetchPageviews" src/ index.ts`: **zero chamadores** fora do
próprio arquivo. O diff acrescentou uma docstring de aviso ("NÃO usar este método para
métricas per-post") a um método que ninguém chama, e copiou o corpo de `fetchBulkPageviews`
quase verbatim — os dois loops de lote diferem apenas na função chamada, no substantivo do log
e em `result.value` vs `result.value !== null`.

**Recomendação:** deletar o par morto neste mesmo commit (o diff já abre o arquivo, e a lição
sobre `report-all` ignorar `id_post` fica preservada na docstring de `fetchUniqueVisitors`, que
já a cita). Isso elimina a duplicação sem precisar de abstração nova. Se preferir manter o par,
extrair o loop de lotes para um helper genérico
`runBatched<T>(items, concurrency, fn, label)`.

### MIN-7 — `!response.ok` retorna null sem logar o status

`src/services/pageview-service.ts:122`

O caminho de exceção loga (`:132`), mas 4xx/5xx sai silencioso. Em 160 chamadas, uma quebra
sistemática da API (mudança de contrato, key revogada) só apareceria como
`[PAGEVIEW] Concluído: 0/160` — sem o código HTTP que explica o porquê.

**Recomendação:** logar `response.status` uma vez por lote ou por chamada (segue o padrão de
`:132`). Mesma observação vale para o `fetchPageviews` existente, se ele sobreviver a MIN-6.

---

## INFO

- **INF-1 — Bug pré-existente de YAML em `docs/openapi.yaml:1130`.** A linha
  `postId: { type: string, description: ID do post no WP, ou \`random\` quando dominio sem dados }`
  usa flow mapping com vírgula não escapada; `js-yaml` parseia
  `"ou \`random\` quando dominio sem dados": null` como chave separada. O YAML valida, mas a
  descrição do `postId` está corrompida no schema. Não é deste diff (confirmado em
  `git show HEAD:docs/openapi.yaml`), mas fica no schema que o diff acabou de editar.
  Correção: aspas na descrição ou bloco `>-`.
- **INF-2 — Comportamento de início de dia.** `todayStr` é o dia corrente em America/Sao_Paulo,
  e uniques acumulam do zero à meia-noite. Nos primeiros ciclos do dia quase nada passa dos 10
  uniques ⇒ ranking cai para eCPM puro, e o critério vira RPS conforme o tráfego entra. É
  degradação graciosa e consistente (revenue também é do dia), mas significa que o critério de
  ranking troca sozinho ao longo da manhã — esperar churn no top 5 nesse período.
- **INF-3 — `tsconfig.json` exclui `**/*.test.ts`.** `npm run build` não typecheca os testes, e
  `tsx --test` roda transpile-only. Erro de tipo em arquivo de teste passa despercebido pelos
  dois gates. Convenção pré-existente do repo, não deste diff.

---

## Lacunas de cobertura

| Arquivo/função modificado | Teste? |
|---|---|
| `src/utils/rps-ranking.ts` (`computeRps`, `sortRpsWithEcpmFallback`) | **Sim** — 17 testes, incluindo boundary 9/10, negativos, NaN, estabilidade, não-mutação, todos-null == eCPM |
| `redirect-controller.ts` — `interleaveByDomain` (comportamento MUDOU) | **Não** — IMP-2 |
| `redirect-controller.ts` — bloco RPS (`:340-364`) | **Não** — miss no `uniquesMap`, falha total da API, mutação de `limitedRanking` in place. Coberto indiretamente pelos testes do util; o glue code (montagem da key `${domain}_${postId}`, `?? 0`, refill do array) não |
| `pageview-service.ts` — `fetchUniqueVisitors` (parse) | **Não** — sem infra de mock de `fetch` no repo (nenhum precedente de teste de service). Argus recomendou extrair `parseUniquesResponse` puro; concordo, e é o mesmo padrão de IMP-2 |
| `pageview-service.ts` — `fetchBulkUniques` (lotes) | **Não** — mesma razão |

Nota de processo: a key do map (`${domain}_${postId}`, `pageview-service.ts:160`) é construída
em um arquivo e consumida em outro (`redirect-controller.ts:349`) por concatenação literal. É
exatamente o tipo de acoplamento que um typo silencia — o sintoma seria "0 itens com RPS
válido" todo ciclo, indistinguível de API fora do ar. Um teste do glue code (IMP-2/lacuna 3)
ou uma função `uniquesKey(domain, postId)` compartilhada fecharia isso.

## Padrões observados

**Bons:**
- Extração da aritmética para util puro testável (`rps-ranking.ts`) em vez de lógica enterrada
  no controller — é o padrão certo e já existente no repo (`exploration-math.ts`,
  `domain-normalize.ts`). A generalização do `interleaveByDomain` deveria ter seguido o mesmo
  caminho (IMP-2).
- Comentários que registram o *porquê* histórico (a lição de 27/07, o `report-all` ignorando
  `id_post`, o motivo do sort defensivo) em vez de narrar o que a linha faz. Consistente com o
  resto do arquivo.
- Fallback nunca esvazia o ranking, e a propriedade está travada por teste
  (`todos-null produz a mesma ordem do ranking eCPM puro`) — a regressão de julho não volta em
  silêncio.
- Feature flag por grupo mantém o raio de explosão em 1 grupo, com custo zero para os demais.

**A vigiar:**
- Duplicação de infraestrutura de I/O por cópia (MIN-6) — segunda vez que o padrão de lotes
  aparece no mesmo arquivo.
- Métodos privados do controller que carregam regra de ordenação continuam fora de teste; o
  controller tem 1970 linhas e é onde mora o risco não coberto.

## Nota de concorrência

`src/utils/rps-ranking.test.ts` foi modificado às 12:28 (Argus) durante esta revisão — revisei
a versão de 12:28 (146 linhas, 17 testes) e rodei a suíte contra ela (29/29). Se houver
alterações posteriores, elas não estão nesta revisão.

---

# Re-review DELTA — Round 2 — Hera, 2026-08-22 12:5x

Escopo: **apenas** as mudanças do Round 2 sobre o que já foi revisado acima. Não repete o review
completo. Base: `git diff` atual + `src/utils/interleave-by-domain.ts`/`.test.ts` novos.

## Veredito do delta

**APROVADO.** As 10 correções estão aplicadas e corretas. Nenhum finding novo bloqueante;
5 MINOR novos, todos opcionais e nenhum precisa entrar antes do commit.

Verificação independente que rodei nesta rodada:

```
npm run build → tsc, saída limpa, 0 erros
npm test      → # tests 35 / # pass 35 / # fail 0
js-yaml       → YAML OK; postId agora parseia como objeto único
                {"type":"string","description":"ID do post no WP, ou `random` quando dominio sem dados"}
```

## 1. IMP-3 (bloco RPS depois de `validateRanking`) — CORRETO

`redirect-controller.ts:313-372`. O invariante "nada reordena entre o sort RPS e o interleave"
**continua valendo**: o bloco RPS é imediatamente seguido por
`interleaveByDomain(validatedRanking, groupDomains)`, sem nenhuma instrução no meio.

Efeitos colaterais da mutação in-place — checados um a um, **nenhum**:

- `validatedRanking` é o array novo criado pelo `.filter` dentro de `validateRanking`
  (`:812-841`). `length = 0` + push mexe só nele; `limitedRanking` é outro array e agora **nunca
  é mutado** (melhor que o Round 1).
- Os *objetos* continuam compartilhados entre `globalRanking`/`limitedRanking`/`validatedRanking`,
  e `item.uniqueVisitors`/`entry.ref.rps` são mutados neles. Mas o único consumidor posterior de
  `limitedRanking` é `domainsValidatedThisCycle = [...new Set(limitedRanking.map(l => l.domain))]`
  (`:405`), que lê só `.domain` — inalterado. Semântica preservada e correta: continua sendo
  "domínios *tentados* neste ciclo", não "domínios que passaram", que é o que a docstring de
  `buildExplorationPool` exige.
- `validPostsMap` é devolvido por `validateRanking` antes do bloco e não é tocado.
- `buildExplorationPool` recebe `topRanking` (já pós-RPS/pós-interleave), então o `topSet` de
  exclusão reflete o ranking real. Correto.
- O guard `if (validatedRanking.length === 0) return null` ficou **antes** do bloco RPS —
  `fetchBulkUniques` nunca é chamado com lista vazia. Bom detalhe.
- `${validatedRanking.length}` no log de `RPS mode:` e no log de "Ranking global atualizado"
  é avaliado depois do refill — contagem certa.

Ganho colateral: o volume de chamadas caiu de `|limitedRanking|` para `|validatedRanking|`.

## 2. IMP-2 (extração de `interleaveByDomain`) — CORRETO

- Corpo da função em `src/utils/interleave-by-domain.ts:30-90` é idêntico linha a linha ao método
  privado removido (agrupamento, `domainsWithData`/`WithoutData`, `firstIndexByDomain`, `maxLinks`,
  round-robin, filler `/random`). Comportamento preservado.
- `LinkInfo`/`RankedLinksList` têm agora **um único definidor**
  (`grep -rn "interface LinkInfo\|type RankedLinksList" src/` → só `interleave-by-domain.ts`);
  o controller importa. Sem duplicação de tipo.
- **Sem ciclo de import**: `interleave-by-domain.ts` → `config/domains`, e
  `grep -n "^import" src/config/domains.ts` não retorna nada — `config/domains.ts` não importa
  ninguém. Grafo acíclico.
- Sem referência pendente a `this.interleaveByDomain`.
- Os 5 testes cobrem exatamente o que pedi. Destaque para o de empate: ele coloca `a.com` primeiro
  em `allDomains` e `b.com` primeiro no ranking, então falharia sob o comportamento antigo — é o
  teste certo para travar o IMP-1 aceito, não uma tautologia.

## 3. IMP-4 (`noOverlap` + concorrência 8) — CORRETO

- Assinatura confere: `schedule(expression, func, options?: TaskOptions)`
  (`node-cron/dist/cjs/node-cron.d.ts:2`) e `TaskOptions.noOverlap?: boolean`
  (`tasks/scheduled-task.d.ts:12`).
- Semântica confere e é a desejada — **pula** a execução, não enfileira
  (`scheduler/runner.js:111-119`: se a última execução está `pending`, loga
  `task still running, new execution blocked by overlap prevention!`, reagenda o próximo match e
  retorna).
- Concorrência 8 passada no call site (`redirect-controller.ts:348`); o default do método segue 3.

Ver N2 abaixo para a lacuna residual (não é erro do que foi feito).

## 4. MIN-6 (remoção do código morto) — LIMPO

`grep -rn "fetchPageviews\|fetchBulkPageviews\|PageviewResult\|PAGEVIEW_API_URL" src/ docs/ index.ts`
retorna **uma única linha**: a menção histórica intencional dentro da docstring de
`fetchUniqueVisitors` (`pageview-service.ts:21`), que era justamente o objetivo — a lição sobre
`report-all` ignorar `id_post` sobreviveu à deleção. Nenhuma referência quebrada, nenhuma doc
órfã no openapi.

## 5. Guard de `computeRps` (MIN-1 + MIN-2) e testes do Argus — PARCIAL, ver N1

`rps-ranking.ts:18`. MIN-1 fechado: `uniques <= 0` mata o bypass com `minUniques = 0` (travado por
teste). MIN-2 fechado do lado de `revenue`: `!Number.isFinite(revenue)` → null (teste do Argus
corretamente reescrito de "propaga NaN" para "retorna null", com comentário explicando a virada —
forma certa de evoluir um teste que documentava comportamento).

Manter o teste de `sortRpsWithEcpmFallback` com `rps: NaN` literal foi a decisão certa: ele testa
a função de sort isolada, que continua sendo API pública e pode receber NaN por outro caminho.

---

## Findings NOVOS do Round 2 (todos MINOR, nenhum bloqueia o commit)

### N1 — MINOR — O endurecimento do guard ficou assimétrico: `uniques` não-finito ainda passa

`src/utils/rps-ranking.ts:18`

`!Number.isFinite(revenue)` foi adicionado, mas não o equivalente para `uniques`. `NaN` escapa dos
três testes existentes (`NaN <= 0` é false, `NaN < 10` é false). Probe real:

```
computeRps(100, NaN, 10)      -> NaN     (esperado: null)
computeRps(100, Infinity, 10) -> 0       (esperado: null; entra em withRps como "RPS 0 válido")
computeRps(NaN, 10, 10)       -> null    OK
computeRps(Infinity, 10, 10)  -> null    OK
```

O caso NaN reproduz exatamente o modo de falha que MIN-2 descrevia (item cai no bucket `withRps`
com posição final indefinida, sem erro). **Impacto real hoje: nenhum** — `fetchUniqueVisitors`
filtra `uniques` com `Number.isFinite` antes de popular o map, então o caminho de produção não
alcança isso. É inconsistência de contrato num util puro exportado cuja docstring agora anuncia
robustez contra dado sujo.

**Recomendação:** trocar por `!Number.isFinite(uniques as number)` no lugar de `uniques <= 0`
(cobre undefined, NaN, Infinity e negativos numa condição só, junto com o `uniques <= 0`), e um
teste para NaN/Infinity. Opcional — pode ir num commit de follow-up.

### N2 — MINOR — `noOverlap` protege cron-vs-cron, mas não cron-vs-`GET /api/process`

`redirect-controller.ts:198` vs `:867` (`process()` → `await this.executeAllGroups()`)

O endpoint manual chama `executeAllGroups()` direto, fora da task do node-cron, então `noOverlap`
não o vê. Um `GET /api/process` disparado durante um ciclo em andamento roda concorrente, com o
dobro da carga na API de pageviews e escritas concorrentes na mesma chave Redis — exatamente o
cenário que IMP-4 queria evitar, por outra porta. Pré-existente, mas o custo por sobreposição
subiu com o modo RPS.

**Recomendação:** um flag de instância (`private cycleRunning = false`) checado em
`executeAllGroups`, retornando 409/"ciclo em andamento" no endpoint. Fora do escopo desta task —
registrar como follow-up.

### N3 — MINOR — Concorrência 8 é número mágico no call site

`redirect-controller.ts:348` passa `8` posicional. O irmão `MIN_UNIQUES_FOR_RPS` é constante
nomeada da classe (`:111`). Um leitor futuro não tem como saber que 8 veio de "derrubar o pior
caso de ~2,7min para ~60s".

**Recomendação:** `private readonly RPS_UNIQUES_CONCURRENCY = 8;` junto de `MIN_UNIQUES_FOR_RPS`,
com o motivo no comentário.

### N4 — MINOR — `BulkPageviewItem` ficou com nome órfão depois do MIN-6

`src/services/pageview-service.ts:9`. Última referência a "Pageview" num arquivo que agora só
busca uniques; o tipo é usado só por `fetchBulkUniques`.

**Recomendação:** renomear para `BulkUniquesItem`. Trivial, um único uso.

### N5 — MINOR — Falta o teste do filler `/random` para domínio esgotado no meio do round-robin

`src/utils/interleave-by-domain.test.ts`

O teste 2 cobre "domínio sem nenhum dado", mas não "domínio que tinha dados e acabou antes dos
outros" — o mesmo `else` do round-robin, e o que faz `topRanking.slice(0, 50)` ter composição não
óbvia. Comportamento verificado por mim na mão (está correto):

```
interleaveByDomain([a:1, a:2, b:1], ['a.com','b.com'])
  -> a.com:1 | b.com:1 | a.com:2 | b.com:random
```

**Recomendação:** um sexto teste com esse caso exato, para travar a paridade de rodadas.

## Findings do Round 1 encerrados neste delta

IMP-2, IMP-3, IMP-4, MIN-1, MIN-2, MIN-3, MIN-4, MIN-5, MIN-6, MIN-7, INF-1 → **resolvidos**.
IMP-1 → aceito como está e agora **travado por teste** (o de empate de eCPM), que é o desfecho
certo: o comportamento novo virou contrato explícito em vez de efeito colateral de refactor.
IMP-5 → decisão de produto do Caio, mantido; segue valendo a recomendação de monitorar
`[CRON-MAIN] RPS mode:` nos primeiros ciclos.
INF-2, INF-3 → informativos, sem ação.

## Lacunas de cobertura remanescentes

- `fetchUniqueVisitors`/`fetchBulkUniques` seguem sem teste de parse (precisaria de mock de
  `fetch`, sem precedente no repo). Aceitável.
- Glue code do bloco RPS no controller (montagem da key `${domain}_${postId}`, `?? 0`, refill do
  array) segue sem teste. Aceitável — mas segue valendo a observação do Round 1: a key é
  construída em `pageview-service.ts:160` e consumida por concatenação literal em
  `redirect-controller.ts:350`; um typo aí produz "0 itens com RPS válido" todo ciclo,
  indistinguível de API fora do ar.
- N5 acima.
