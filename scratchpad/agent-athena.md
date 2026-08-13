# Exploração 10% no redirect — implementação

## Contexto
Branch `feat/exploration-10pct`. Loop de retroalimentação identificado: só o top 50 do
ranking eCPM recebia impressões, então só ele passava do piso de 100 impressões, e o
conjunto congelava — URLs novas nunca entravam. Implementada exploração epsilon-greedy
de 10% do tráfego servindo posts WP válidos fora do top 50, em todos os grupos/slugs
(Opção A já aprovada: post válido aleatório fora do top, não `/random`).

## Decisões
- Pool de exploração construído no cron (`executeProcessForGroup`), reaproveitando
  `fetchAllValidPosts` (hit no cache em memória `validPostsCache` recém-populado por
  `validateRanking` — zero chamadas WP extra).
- Candidatos: IDs válidos por domínio fora do `topRanking`, embaralhados (Fisher-Yates)
  e limitados a 30 por domínio; intercalados por domínio (domínios sub-representados no
  topRanking primeiro), cap de 300 itens totais.
- Salvo no Redis em `redirect:exploration_pool:${slug}`, EX 3600 (igual ao ranking).
- Serving: fatia determinística de 10% via `visitIndex % EXPLORATION_MOD === MOD-1`
  (sem chamada extra ao Redis para decidir), aplicada ANTES do branch bestRpsMode nos
  dois handlers (`redirect()` e `redirectByGroup()`) — exploração é ortogonal ao modo.
  `getGlobalVisitIndex` foi movido para antes do branch de modo; em bestRpsMode o
  counter Redis passa a incrementar também (aceitável e necessário pra fatia valer
  nos dois modos).
- **Correção crítica de starvation**: como `ranking.length` (50) é múltiplo de
  `EXPLORATION_MOD` (10), usar `visitIndex % ranking.length` para o índice do ranking
  nos requests não-exploração faria os slots 9,19,29,39,49 nunca serem servidos.
  Trocado por `rankCounter = visitIndex - Math.floor((visitIndex+1)/MOD); idx =
  rankCounter % ranking.length` — mapeia os 90% de requests em índices consecutivos
  do ranking. Verificado por script (ver abaixo): distribuição perfeitamente uniforme
  entre os 50 slots (180 hits cada em 10k requests simulados).
- Pool ausente/vazio (ex.: antes do primeiro cron rodar) cai transparentemente no fluxo
  normal (bestRpsMode ou rank com a fórmula corrigida) — sem servir lixo.
- Leitura do pool (`getExplorationPoolForGroup`) só é chamada quando a request já foi
  decidida como exploração — não paga Redis extra nos 90% normais. Cache em memória
  60s (mesmo padrão de `getBestLinksMapForGroup` / `bestLinksMapCaches`).
- `linkId` com prefixo `explore_${slug}_${domain}_${postId}` (essencial pra atribuição
  de clicks — vira utm_campaign default e vai pro `redirectClickRepository`, que é
  agnóstico a prefixo, então não precisou de allow-list em nenhum outro lugar).
- Constante única `EXPLORATION_MOD = 10` usada nos dois handlers, nada hardcoded
  duplicado.

## Arquivos tocados
- `src/controllers/redirect-controller.ts` (único arquivo alterado — 200 inserções,
  33 remoções): novo campo `explorationPoolCaches`, constante `EXPLORATION_MOD`,
  `getRedisKeyForExplorationPool`, `buildExplorationPool` (novo método, chamado ao
  fim de `executeProcessForGroup`), `getExplorationPoolForGroup` (espelha
  `getBestLinksMapForGroup`), e os branches de serving reescritos em `redirect()` e
  `redirectByGroup()`.

## Não mexido (fora de escopo, conforme instrução)
- `getBestRpsLink` não foi tocado internamente — a fatia de exploração acontece antes
  do branch, não dentro dele.
- Formato do ranking salvo no Redis e shape de `/api/rank` inalterados.
- `docs/openapi.yaml` não tocado (nenhum endpoint documentado mudou de comportamento
  visível — a exploração é interna ao serving existente).

## Comandos rodados + resultados reais

```
$ npm run build
> redirect@1.0.0 build
> tsc
(saída vazia — build limpo, sem erros)
```

Script de verificação em
`/private/tmp/claude-501/-Users-caionorder-Dev-Node-redirect/de919f54-9951-4d29-9f6e-c36f3364bf7e/scratchpad/verify-exploration.ts`,
replicando literalmente as expressões do controller (`EXPLORATION_MOD`,
`isExplorationRequest`, `poolIdx`, `rankCounter`, `idx`), simulando `visitIndex` de 0
a 9999 com `ranking.length = 50` e `pool.length = 37`:

```
$ npx tsx verify-exploration.ts
Total simulado: 10000
Requests de exploração: 1000 (10.00%)
OK (a): exploração = exatamente 1000 (10% de 10000)
Rank hits por slot: min=180, max=180, total=9000
OK (b): todos os 50 slots do ranking foram servidos, distribuição uniforme (min=180, max=180)
Pool hits por slot: min=27, max=28, total=1000
OK (c): todos os 37 slots do pool foram servidos em round-robin, distribuição uniforme (min=27, max=28)

TODOS OS ASSERTS PASSARAM.
```

Confirma as 3 propriedades pedidas: (a) exatamente 10% em exploração; (b) nenhum slot
do ranking com 0 hits, distribuição perfeitamente uniforme; (c) pool percorrido em
round-robin completo, todos os slots visitados quase uniformemente (diferença de no
máximo 1 hit, esperado já que 1000 não é múltiplo exato de 37).

## Riscos / observações
- Sem infra de testes de integração no repo (`npm test` é stub) — verificação ficou
  restrita a build tsc + script de simulação da aritmética (que é a parte não-trivial
  e propensa a erro desse desenho). O restante (leitura/escrita Redis, cache em
  memória, shuffle) segue exatamente o padrão já existente em `getBestLinksMapForGroup`
  / `fetchAllValidPosts`, sem lógica nova de risco.
- Primeiro deploy: até o cron rodar pela primeira vez (roda imediatamente na
  inicialização do worker 1, `executeAllGroups()` em `initializeScheduledProcess`), o
  pool estará vazio/ausente no Redis — fallback transparente garante que o serving
  continua normal (sem exploração) até lá, sem quebrar nada.
- `EXPLORATION_MOD` está fixo em 10 (não configurável por grupo/slug) — se no futuro
  precisar de fatias diferentes por grupo, isso viraria um campo em `getGroupConfig`.
  Não implementado por não estar no escopo aprovado.

## Próximos passos (round 1)
- Nenhum bloqueio. Pronto para review (Hera) dado que é lógica de negócio não-trivial
  tocando o serving path principal do produto — risco Médio pela superfície tocada
  (dois handlers de serving + cron), mesmo sem PII/auth/pagamento envolvidos.

---

# Round 2 — fixes da review Hera (`scratchpad/agent-hera-exploration.md`)

Veredito da Hera: **APROVADO COM RESSALVAS**, sem blocker. Aplicados todos os IMPORTANT
(F1-F4) e MINOR (M1-M3) marcados como obrigatórios pelo orquestrador, mais os NIT N1-N3.
Findings 3 e 5 e o MINOR de cobertura horária do pool foram aceitos conscientemente, sem
mudança de código (conforme decisão do orquestrador), com comentário registrando o
tradeoff onde aplicável.

## Fixes aplicados

**F1 — eliminado o double-fetch WP de domínios quebrados no mesmo ciclo.**
`validateRanking` agora retorna `{ ranking, validPostsMap }` (antes retornava só o
ranking) — o `validPostsMap` já resolvido é passado para `buildExplorationPool` em vez
de chamado de novo. Comentário do método atualizado para não afirmar mais "nenhuma
chamada WP extra" de forma incondicional (isso só vale para os domínios já tentados
neste ciclo — ver F2 abaixo para os que não).

**F2 — universo de exploração expandido para `groupDomains` (todo o grupo), não só os
domínios que monetizam hoje.** `buildExplorationPool` agora recebe `groupDomains`,
`domainsValidatedThisCycle` (os que já passaram por `validateRanking` neste ciclo) e o
`validPostsMap` do ciclo. Para os domínios de `groupDomains` que NÃO estão em
`domainsValidatedThisCycle`, chama `fetchAllValidPosts` só para esses (cache de 60min
por domínio absorve o custo nos ciclos seguintes) e mescla no `validPostsMap` local.
Domínios que já falharam a validação neste ciclo NÃO são re-tentados aqui — ficam fora
do pool deste ciclo, retry natural no próximo cron (mesma política que `fetchAllValidPosts`
já aplica para o próprio `validateRanking`, introduzida em b10cd19).

**F3 — coerência com `bestRpsMode`.** `groupConfig`/`mainConfig` agora é buscado ANTES
da decisão de exploração (o service já cacheia, custo desprezível). Quando a request cai
na fatia de exploração E o grupo tem `bestRpsMode` habilitado, o domínio servido é
marcado como visitado via `addVisitedDomain(clientIp, slug, domain)` (fire-and-forget,
`.catch(() => {})`) — helper que já existia (`:840` na numeração antiga) mas estava sem
nenhum caller. Isso mantém o rodízio por IP do `getBestRpsLink` coerente: sem essa
marcação, 10% das requests em grupos bestRps poderiam repetir domínio dentro da hora.
Tipo do parâmetro `type` de `addVisitedDomain` foi alargado de `'main' | 'db'` para
`string`, para aceitar qualquer slug (mesmo padrão que `getVisitorKey` já aceitava).

**F4 — aritmética extraída para funções puras + teste versionado.** Novo módulo
`src/utils/exploration-math.ts` exporta `isExplorationRequest`, `explorationPoolIndex`,
`rankIndex` e `decideServingSource` (esta última compõe as três, decidindo pool vs
ranking incluindo o caso de pool vazio — usada pelos dois handlers para reduzir a
duplicação de aritmética entre eles). `redirect-controller.ts` agora importa e usa essas
funções em vez de repetir as expressões inline nos dois handlers. Teste novo
`src/utils/exploration-math.test.ts` (`node:test`, zero dependência nova) cobrindo: 10%
exato; nenhuma starvation com `rankLen` 50, 47, 10, 7, 3, 1 (múltiplos e não-múltiplos de
`MOD`); pool em round-robin completo para `poolLen` 300, 37, 10, 5, 1; offset de counter
arbitrário (contagem em curso); `decideServingSource` com pool vazio (tudo cai no
ranking, sem starvation) e com pool populado (exatamente 1/mod pro pool, resto uniforme
no ranking). `package.json`'s `test` script trocado de stub para
`tsx --test src/**/*.test.ts`.

## Fixes menores aplicados

- **M1**: `buildExplorationPool` só é chamado dentro de `if (this.redisClient)` no
  `executeProcessForGroup` — antes rodava e descartava o resultado se Redis estivesse
  indisponível.
- **M2**: `redisClient.set` do pool envolvido em try/catch com log — falha ao salvar o
  pool não derruba mais `/api/process` nem o cron; o ranking (feature existente) já foi
  salvo antes, ordem preservada.
- **M3**: Fisher-Yates completo trocado por shuffle parcial (só `sampleSize` swaps, onde
  `sampleSize = min(EXPLORATION_SAMPLE_PER_DOMAIN, candidates.length)`) — evita embaralhar
  o catálogo WP inteiro (paginação sem teto) só para aproveitar 30 itens por domínio.
- **N1**: `300` e `30` promovidos a `EXPLORATION_POOL_CAP` e
  `EXPLORATION_SAMPLE_PER_DOMAIN`, campos de classe nomeados junto de `EXPLORATION_MOD`.
- **N2**: comentário de `EXPLORATION_MOD` agora descreve "1/N do tráfego" em vez de fixar
  "(10%)".
- **N3**: a justificativa da correção de starvation (agora só no docstring de `rankIndex`
  em `exploration-math.ts`, já que a fórmula saiu do controller) deixa explícito que vale
  para qualquer `rankingLength`, não só quando é múltiplo de `mod`.

## Decisões aceitas sem mudança de código (conforme instrução do orquestrador)

- **Finding 3** (Hera): `getGlobalVisitIndex` fora do branch de modo agora custa +1 INCR
  Redis por request em grupos `bestRpsMode` (antes, zero). Aceito conscientemente —
  comentário no código (`redirect()` e `redirectByGroup()`, junto de onde `visitIndex` é
  obtido) registra o tradeoff: é intrínseco ao desenho, necessário pra fatia de
  exploração valer nesse modo também.
- **Finding 5** (Hera): clicks com `linkId` prefixo `explore_*` não aparecem em
  `/api/rank` (bug pré-existente de reporting em `redirect-click-repository.ts`, que já
  afetava `bestrps_*` e `rank<i>_<slug>_*` antes desta mudança). Fora do escopo — não
  tocado.
- **MINOR** (Hera): cobertura do pool em slugs de baixo tráfego — o counter de
  `Math.floor(visitIndex/MOD)` reseta a cada hora (TTL do counter), então um slug precisa
  de milhares de requests/hora pra cobrir os 300 slots do pool. Aceito, mitigado pelo
  re-shuffle do pool a cada 15 min — desenho não alterado.

## Arquivos tocados (round 2)

- `src/controllers/redirect-controller.ts` — `validateRanking` (novo tipo de retorno),
  `buildExplorationPool` (nova assinatura com `groupDomains`/`domainsValidatedThisCycle`/
  `validPostsMapFromRanking`, shuffle parcial, guard de Redis, try/catch no save),
  `addVisitedDomain` (tipo `type` alargado), novos campos `EXPLORATION_POOL_CAP` e
  `EXPLORATION_SAMPLE_PER_DOMAIN`, import de `exploration-math`, e os dois handlers de
  serving reescritos para usar `decideServingSource` + marcar domínio visitado no branch
  de exploração em `bestRpsMode`.
- `src/utils/exploration-math.ts` (novo) — funções puras.
- `src/utils/exploration-math.test.ts` (novo) — testes `node:test`.
- `package.json` — script `test` trocado de stub para `tsx --test src/**/*.test.ts`.

## Comandos rodados + resultados reais (round 2)

```
$ npm run build
> redirect@1.0.0 build
> tsc
(saída vazia — build limpo, sem erros)
```

```
$ npm test
> redirect@1.0.0 test
> tsx --test src/**/*.test.ts

TAP version 13
# Subtest: isExplorationRequest: exatamente 1/mod dos índices caem em exploração
ok 1 - isExplorationRequest: exatamente 1/mod dos índices caem em exploração
# Subtest: rankIndex: nenhuma starvation e distribuição uniforme, para vários tamanhos de ranking
ok 2 - rankIndex: nenhuma starvation e distribuição uniforme, para vários tamanhos de ranking
# Subtest: explorationPoolIndex: round-robin completo sobre o pool, para vários tamanhos
ok 3 - explorationPoolIndex: round-robin completo sobre o pool, para vários tamanhos
# Subtest: rankIndex: offset de counter arbitrário (contagem em curso, não iniciando do zero)
ok 4 - rankIndex: offset de counter arbitrário (contagem em curso, não iniciando do zero)
# Subtest: decideServingSource: pool vazio (length 0) -> tudo cai no ranking, sem starvation
ok 5 - decideServingSource: pool vazio (length 0) -> tudo cai no ranking, sem starvation
# Subtest: decideServingSource: pool com itens -> exatamente 1/mod das requests vai pro pool, resto pro ranking uniforme
ok 6 - decideServingSource: pool com itens -> exatamente 1/mod das requests vai pro pool, resto pro ranking uniforme
1..6
# tests 6
# pass 6
# fail 0
```

Script de simulação do round 1 re-rodado importando as funções reais (em vez de copiar
as expressões), em
`/private/tmp/claude-501/-Users-caionorder-Dev-Node-redirect/de919f54-9951-4d29-9f6e-c36f3364bf7e/scratchpad/verify-exploration-round2.ts`:

```
$ npx tsx verify-exploration-round2.ts
Total simulado: 10000
Requests de exploração: 1000 (10.00%)
OK (a): exploração = exatamente 1000 (10% de 10000)
Rank hits por slot: min=180, max=180, total=9000
OK (b): todos os 50 slots do ranking servidos, uniforme (min=180, max=180)
Pool hits por slot: min=27, max=28, total=1000
OK (c): todos os 37 slots do pool servidos em round-robin, uniforme (min=27, max=28)

TODOS OS ASSERTS PASSARAM (importando as funções reais do controller).
```

## Riscos / observações (round 2)

- F2 aumenta o custo de rede do cron: domínios do grupo sem dado GAM hoje agora são
  validados via WP a cada ciclo em que a entrada de cache (60min) expirar — antes eram
  ignorados pelo pool inteiramente. Custo esperado e aceito pelo orquestrador (é o
  propósito central da mudança: dar exploração a domínios sem monetização hoje).
- Nenhum teste de integração real contra Redis/WP — os testes novos cobrem só a
  aritmética pura (a parte que a Hera apontou como sem rede de segurança). O resto
  (`buildExplorationPool`, `addVisitedDomain`, guards de Redis) segue os mesmos padrões
  já existentes no arquivo, verificado por leitura + `npm run build`.

## Próximos passos (round 2)

- Nenhum bloqueio. Diff final revisado — nenhuma mudança fora dos fixes listados acima
  (F1-F4, M1-M3, N1-N3) e das decisões explicitamente aceitas sem código. Pronto para
  nova rodada de review se o orquestrador julgar necessário, ou para commit/PR.

---

# Round 3 — hotfix urgente: domínio GAM com underscore (`fix/gam-domain-underscore`)

Task separada, nova branch a partir da `main` atualizada (que já tinha o merge de
`feat/exploration-10pct` e o ajuste posterior `chore/exploration-5pct`, reduzindo
`EXPLORATION_MOD` de 10 para 20 — confirmado em `git log`, não fui eu quem fez essa
redução, veio de outro ciclo). `git pull origin main` → já atualizado. Branch criada:
`fix/gam-domain-underscore`.

## Contexto / root cause (fornecido pelo orquestrador, não re-investigado)

Entre 05-08/08/2026 os ad units do GAM foram renomeados e o campo `domain` retornado
pelo ETL passou a vir com underscore(s) final(is) (`dopeaaps.com_`). O grupo `main` tem
os domínios limpos (sem `_`), o filtro da query GAM é match exato, então 16/17 domínios
sumiram do ranking desde ~08/08 — causa raiz da queda de receita reportada.

## Fix aplicado

Tudo em `executeProcessForGroup` (`src/controllers/redirect-controller.ts`):

1. **Query expandida**: `filterRequest.domain` agora é
   `[...groupDomains, ...groupDomains.map(d => \`${d}_\`)]` — casa as duas formas
   (limpo e com underscore final) sem tocar no builder/superfilter.
2. **Normalização centralizada**: nova função `normalizeGamDomain` em
   `src/utils/domain-normalize.ts` (`domain.replace(/_+$/, '')` — remove só underscore(s)
   no FINAL, preserva underscore no meio do domínio, ex.: `meu_site.com`). Aplicada no
   loop que constrói `globalRanking`, ANTES de qualquer uso do domínio (URL, chave de
   agrupamento, tudo a jusante — interleave, validação WP, pool de exploração — já usa o
   valor normalizado, sem precisar de mudança em nenhum outro método).
3. **Dedup do caso de transição**: como a query agora casa as duas formas mas o
   agrupamento do superfilter (`group: ["domain", "custom_key", "custom_value"]`) é
   pré-normalização, um dia com dado misto (`dopeaaps.com` e `dopeaaps.com_` para o
   mesmo post) gera duas linhas que colapsam na mesma chave `domain:postId` após
   normalizar. Implementado como `Map<string, LinkInfo>` (`dedupedByKey`) no lugar do
   antigo `push` direto num array: para cada chave, mantém só o item de MAIOR `revenue`
   e descarta o outro — não soma (mudaria o eCPM, que já vem calculado do GAM). Comentário
   no código documenta que isso é esperado só em dias de transição.

Não toquei no builder/superfilter (fora do escopo pedido) nem em `impressions` (o piso
de 100 impressões continua aplicado por linha, antes da normalização/dedup — casos de
transição com impressões divididas entre as duas variantes do domínio não foram
tratados, não fazia parte do pedido; documentado aqui como observação, não como fix).

## Arquivos tocados

- `src/controllers/redirect-controller.ts` — import de `normalizeGamDomain`,
  `filterRequest.domain` expandido, loop de construção do `globalRanking` reescrito
  (normalização + dedup por maior revenue). Diff mínimo: +23/-6 linhas, só nesse trecho.
- `src/utils/domain-normalize.ts` (novo) — `normalizeGamDomain`.
- `src/utils/domain-normalize.test.ts` (novo) — testes `node:test` cobrindo: sem `_`; um
  `_`; múltiplos `__`/`___`; string vazia; string só de `_`; underscore no MEIO do
  domínio preservado (só o sufixo é removido).

## Comandos rodados + resultados reais

```
$ npm run build
> redirect@1.0.0 build
> tsc
(saída vazia — build limpo, sem erros)
```

```
$ npm test
> redirect@1.0.0 test
> tsx --test $(find src -name '*.test.ts')
...
1..12
# tests 12
# suites 0
# pass 12
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

12 testes passando: os 6 novos de `domain-normalize.test.ts` (round 3) mais os 6
existentes de `exploration-math.test.ts` (round 2, suite não quebrada por este fix —
`package.json`'s `test` script já usa `find src -name '*.test.ts'`, que pega os dois
arquivos automaticamente).

## Riscos / observações

- Fix aplicado a `executeProcessForGroup`, usado por TODOS os slugs/grupos (não só
  `main`) — correto, já que o problema é no ETL/GAM, não específico de um grupo.
- Dedup por maior revenue é uma escolha determinística para o caso raro de transição
  (dado misto no mesmo dia); não houve como testar contra dado real do GAM (sem acesso a
  produção), a lógica foi verificada só por leitura + build + os testes de
  `normalizeGamDomain`. Recomendo confirmar no primeiro ciclo do cron em produção que o
  ranking volta a incluir os 16/17 domínios que sumiram (`/api/rank` ou
  `/api/distinct/domain` para conferir que o campo normalizado bate com os domínios do
  grupo).
- Não mexi no builder/superfilter nem em `GamAdUnitRepository` — se o ETL voltar a
  produzir domain limpo no futuro, a query segue funcionando (a variante `_` some dos
  resultados, sem erro).

## Próximos passos (round 3)

- Nenhum bloqueio. Diff mínimo e escopado exatamente ao pedido (query + normalização +
  dedup). Não commitei/pushei — orquestrador cuida do git flow por ser hotfix urgente.
