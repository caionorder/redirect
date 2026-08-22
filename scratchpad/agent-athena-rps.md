# RPS ranking (bestRpsMode) — Athena, 2026-08-22

## Resumo por arquivo

### src/services/pageview-service.ts
- Adicionado `fetchUniqueVisitors(domain, postId, date): Promise<number|null>` chamando
  `POST https://pageview.joinads.me/api/report-key-value-first/0f99f85f-ae1f-4028-a414-b47b1740083e`
  com body `{domain, to, from, keyvalue: "id_post_wp=<postId>"}`. Timeout 3s (AbortSignal). Retorna
  null em erro/timeout/status!=success/payload inesperado; parse defensivo de `data[0].visitas`.
- Adicionado `fetchBulkUniques(items, date, concurrency=3): Promise<Map<string, number>>` — mesmo
  padrão de lotes/logs do `fetchBulkPageviews` existente. Key do map: `${domain}_${postId}`.
- Docstring de `fetchPageviews` atualizada: documenta que `report-all` (modo count) IGNORA
  `id_post` (retorna total do domínio) — não usar para per-post. Método antigo intacto, não
  removido (fora de escopo).

### src/utils/rps-ranking.ts (novo) + rps-ranking.test.ts (novo)
- `computeRps(revenue, uniques, minUniques)`: null se uniques undefined/`< minUniques` (inclui 0);
  senão `revenue/uniques`. Revenue 0 com uniques válido é RPS 0 (válido, não null).
- `sortRpsWithEcpmFallback(items)`: itens com `rps != null` primeiro (rps desc, desempate ecpm
  desc, depois revenue desc); itens com `rps === null` depois (ecpm desc, revenue desc). Não muta
  o array de entrada (usa `.filter` + `[...spread]`).
- 10 testes node:test cobrindo os casos do design (null, desempates, todos-null == ordem eCPM
  pura, array vazio, não-mutação).

### src/controllers/redirect-controller.ts
- Import de `PageviewService` e `computeRps`/`sortRpsWithEcpmFallback`/`RpsRankable`.
- Novo campo `pageviewService: PageviewService` (instanciado no constructor) e constante
  `MIN_UNIQUES_FOR_RPS = 10`.
- `executeProcessForGroup`: após o sort eCPM defensivo do `limitedRanking` (que segue existindo,
  pois é a base para o modo eCPM puro), lê `groupConfig = getGroupConfig(slug)`. Se
  `groupConfig?.bestRpsMode`: chama `fetchBulkUniques` para os itens de `limitedRanking` (mesmo
  `todayStr` já calculado), calcula `rps` via `computeRps` por item, preenche
  `item.uniqueVisitors` (0 se não obtido), reordena `limitedRanking` com
  `sortRpsWithEcpmFallback` (convertendo `rps===null` para `0` só no objeto final salvo — a
  ordenação em si usa o null), e loga
  `[CRON-<SLUG>] RPS mode: X/Y uniques obtidos, Z itens com RPS válido (>=10 uniques), fallback
  eCPM para W`. Fora do modo RPS, o caminho antigo (sort eCPM puro) fica intocado.
- Log do top 5 agora bifurca: em modo RPS mostra RPS/uniques + eCPM/revenue; fora do modo, só
  eCPM/revenue como antes.
- `interleaveByDomain`: generalizado para ordenar os domínios pela POSIÇÃO da primeira ocorrência
  do domínio na lista `ranking` recebida (já ordenada pelo critério ativo), em vez de
  `domainGroups.get(domain)![0].ecpm`. Equivalente ao comportamento atual em modo eCPM (input
  vem eCPM-desc) e preserva a ordem RPS quando ativo. Docstrings atualizadas.
- Docstring de `executeProcessForGroup` (linha ~230) atualizada: não diz mais "sempre 0" — diz
  que uniqueVisitors/rps são reais em grupos bestRpsMode, 0 nos demais.

### docs/openapi.yaml
- `RankedLink.uniqueVisitors` e `.rps`: removido `deprecated: true`, descrição atualizada para
  refletir que são reais em grupos `bestRpsMode: true` (desde 2026-08-22) e 0 nos demais.
  Validado com `js-yaml` (parse OK).

## Decisões / desvios do plano
- Nenhum desvio relevante. Único detalhe de implementação: usei um array intermediário
  `(RpsRankable & { ref: LinkInfo })[]` para reordenar `limitedRanking` via
  `sortRpsWithEcpmFallback` sem precisar duplicar a lógica de ordenação dentro do controller —
  `ref` aponta de volta para o objeto `LinkInfo` original, que é mutado (`rps`, `uniqueVisitors`)
  e reempilhado na nova ordem.
- `groupConfig` é buscado uma vez por ciclo/grupo (cache de 60s do `DomainGroupService`, custo
  desprezível) mesmo para grupos sem `bestRpsMode`, para poder reusar o mesmo valor no log do
  top 5 sem segunda chamada.

## Comandos rodados (resultados reais)
- `node -e "yaml.load(...)"` → `YAML OK`
- `npm run build` → `tsc` sem erros (saída limpa, sem warnings)
- `npm test` → `tsx --test $(find src -name '*.test.ts')`:
  ```
  # tests 22
  # suites 0
  # pass 22
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  ```
  Inclui os 6 testes pré-existentes de `domain-normalize`/`exploration-math` + os 10 novos de
  `rps-ranking.test.ts`, todos `ok`.

## Diff final (git diff --stat)
```
 docs/openapi.yaml                      | 12 +++--
 src/controllers/redirect-controller.ts | 80 ++++++++++++++++++++++++++++-----
 src/services/pageview-service.ts       | 82 ++++++++++++++++++++++++++++++++++
 3 files changed, 159 insertions(+), 15 deletions(-)
```
Mais `src/utils/rps-ranking.ts` (novo, 33 linhas) e `src/utils/rps-ranking.test.ts` (novo, 82
linhas) — só os arquivos do escopo. Nenhum secret novo (a API key hardcoded já existia em
`pageview-service.ts`, é a mesma usada pelo endpoint `report-key-value-first` verificado ao vivo
pelo Caio). Nenhuma mudança em `getBestRpsLink`, pool de exploração, `validateRanking`, corte de
100 impressões, ou linkIds `bestrps_*`.

## Riscos e pontos de atenção para o reviewer
- **Custo de rede por ciclo do cron**: em modo RPS, cada ciclo (15 min) do grupo `main` agora faz
  até ~160 chamadas HTTP extras (`fetchBulkUniques`, concurrency 3, timeout 3s cada) para a API
  `pageview.joinads.me`. Pior caso ~160/3 lotes sequenciais × até 3s = até ~160s se a API estiver
  lenta/instável (mas timeouts individuais de 3s por item, não bloqueiam lotes seguintes além do
  timeout). Isso já era esperado pelo design ("corte de 100 imps + top 10/domínio... limita as
  chamadas a ~<=160 no pior caso").
- **`groupConfig?.bestRpsMode` é lido 1x por grupo por ciclo** — se o cache do
  `DomainGroupService` (TTL 60s) tiver dado desatualizado, a decisão de modo pode ficar até 1 min
  atrasada em relação a uma mudança de flag feita via API — comportamento pré-existente do
  serviço, não introduzido por esta mudança.
- **`item.rps = entry.rps ?? 0`**: o valor 0 salvo no Redis para itens sem RPS válido é
  indistinguível (no payload) de um RPS real de exatamente 0 (revenue 0, uniques>=10, caso válido
  testado). Isso é esperado — documentado no openapi.yaml — mas se um consumidor externo algum
  dia interpretar `rps: 0` como "sem dado" incorretamente, pode gerar confusão. Não há campo
  boolean explícito "rpsValid" no payload (fora do escopo pedido).
- **`interleaveByDomain` generalizado**: testado indiretamente via build+tsc (tipos) mas não há
  teste unitário dedicado para este método (ele é privado no controller, não foi extraído para
  função pura — fora do escopo do design solicitado). Comportamento em modo eCPM puro é
  matematicamente equivalente ao anterior (primeira ocorrência == melhor eCPM, já que o array de
  entrada vem eCPM-desc); validado por leitura de código, não por teste automatizado.
- Nenhuma verificação end-to-end contra a API real de `report-key-value-first` foi feita nesta
  sessão (verificação ao vivo já havia sido feita pelo Caio antes da task, conforme contexto
  recebido). Recomendo Zeus/Poseidon ou o próprio Caio confirmarem em staging/produção no
  primeiro ciclo do cron após deploy, olhando os logs `[CRON-MAIN] RPS mode: ...`.

## Stop condition (Round 1)
Atingida: implementação completa conforme design; `npm run build` limpo; `npm test` 100% pass
(22/22, incluindo os 10 novos testes); diff contém apenas os arquivos esperados; scratchpad
escrito. Nenhum bloqueio.

---

## Round 2 — correções pós-review (Hera + Argus), 2026-08-22

Aplicadas as 10 correções decididas pelo orquestrador sobre os findings de
`scratchpad/agent-hera-rps.md` (0 blocker/critical, 5 IMPORTANT, 7 MINOR, 3 INFO) e
`scratchpad/agent-argus-rps.md` (29/29 testes, 1 finding de robustez em `computeRps`).

### IMP-3 — bloco RPS movido para depois de `validateRanking`
`src/controllers/redirect-controller.ts`: o bloco que busca uniques/computa RPS agora roda
DEPOIS de `validateRanking` e opera sobre `validatedRanking` (não mais `limitedRanking`), com o
`if (validatedRanking.length === 0) return null` movido para antes do bloco RPS. Isso evita pagar
`fetchBulkUniques` para posts que a validação WP descarta. `domainsValidatedThisCycle` (pool de
exploração) continua lendo `limitedRanking`, que permanece só eCPM-ordenado e nunca mais é
mutado — comportamento idêntico ao anterior nesse ponto. Comentários atualizados para deixar
explícito que nada entre o bloco RPS e `interleaveByDomain` reordena `validatedRanking` de novo.

### IMP-4 — guarda de sobreposição do cron + concorrência maior
(a) `cron.schedule('*/15 * * * *', callback, { noOverlap: true })` — confirmado via
`node_modules/node-cron/dist/cjs/scheduler/runner.d.ts`/`.js` que a opção existe e que o default
é `false`. (b) `fetchBulkUniques` agora é chamado com `concurrency=8` (era 3, herdado do
`fetchBulkPageviews` morto) — derruba o pior caso de ~160 chamadas de ~2,7min para ~60s.

### IMP-2 — `interleaveByDomain` extraído para util puro + testado
Novo `src/utils/interleave-by-domain.ts`: exporta `LinkInfo`, `RankedLinksList` (movidos para cá,
únicos definidores agora — o controller importa em vez de redefinir) e a função pura
`interleaveByDomain(ranking, allDomains)`, corpo idêntico ao método privado removido do
controller. `generateRandomPath` importado de `../config/domains` (sem ciclo — controller também
importa de lá para outros usos, `config/domains.ts` não depende de nada em `utils/` ou
`controllers/`). Novo `src/utils/interleave-by-domain.test.ts` com os 4 casos pedidos pela Hera:
round-robin básico, domínio sem dados vira `/random` no fim de cada rodada, empate de eCPM entre
domínios fixando o novo comportamento (desempate por posição no ranking recebido, isto é,
revenue — IMP-1, aceito como está), e ordem RPS preservada (ranking de entrada não ordenado por
eCPM). Mais um teste de array vazio.

### MIN-1 + MIN-2 — guard de `computeRps` endurecido
`src/utils/rps-ranking.ts`: guard passou de `uniques === undefined || uniques < minUniques` para
`uniques === undefined || uniques <= 0 || uniques < minUniques || !Number.isFinite(revenue)`.
Fecha dois gaps reportados: `minUniques = 0` não bypassa mais o guard (MIN-1), e `revenue` NaN
(dado sujo vindo do ranking eCPM, sem relação com `PageviewService`) agora cai no fallback eCPM
em vez de propagar um RPS "válido" com posição indefinida no sort (MIN-2, finding original de
Argus). Teste do Argus que documentava a propagação de NaN foi reescrito para esperar `null`
("revenue NaN com uniques válido retorna null (guardado, cai no fallback eCPM)"); adicionei mais
um teste de boundary (`uniques 0` com `minUniques 0`). O teste de `sortRpsWithEcpmFallback` com
`rps: NaN` literal (bypassando `computeRps`) foi mantido como está — ainda é uma defesa em
profundidade válida da função de sort isolada.

### MIN-3 — docstring de `getBestRpsLink`
Trocado "round 0 holds the best-eCPM link" / "highest-eCPM link" por linguagem agnóstica de
critério ("each domain's best item according to the active criterion (eCPM, or
RPS-with-eCPM-fallback in bestRpsMode groups)"). Também corrigi a frase final, que dizia "do not
rename even though RPS no longer applies" — desatualizada desde que esta mesma mudança reativou
RPS para grupos bestRpsMode; ficou "do not rename, regardless of which ranking criterion is
active for the group".

### MIN-4 — cabeçalhos "ranking eCPM" atualizados
Docstring de `executeProcessForGroup` e `description` do schema `RankedLink` no openapi:
"ranking global por eCPM (ou por RPS em grupos bestRpsMode...)".

### MIN-5 — openapi documenta o terceiro significado de `uniqueVisitors: 0`
Acrescentado "(0 também quando a chamada à API de pageviews falhou neste ciclo, em grupos
bestRpsMode)".

### MIN-6 — código morto removido
`src/services/pageview-service.ts`: deletados `fetchPageviews` e `fetchBulkPageviews` (zero
callers confirmado via grep) e as interfaces órfãs `PageviewResult`/`PageviewApiResponse`
(`PAGEVIEW_API_URL` também removida). `BulkPageviewItem` mantida — ainda usada por
`fetchBulkUniques`. A lição sobre `report-all` ignorar `id_post` foi preservada na docstring de
`fetchUniqueVisitors`, citando explicitamente que veio do `fetchPageviews` removido.

### MIN-7 — log de status HTTP em `fetchUniqueVisitors`
`!response.ok` agora loga `HTTP ${response.status}` antes de retornar null (mesmo padrão do
catch existente).

### INF-1 — flow-mapping quebrado no openapi corrigido
`postId` do schema `RankedLink`: a descrição inline com vírgula não escapada (que o `js-yaml`
parseava como uma chave YAML separada) virou bloco `type`/`description` de duas linhas com a
descrição entre aspas. Revalidado com `js-yaml` — schema agora parseia como objeto único
(`{type: string, description: "ID do post no WP, ou \`random\` quando dominio sem dados"}`).

### NÃO aplicado (decisões do orquestrador, preservadas)
IMP-1 aceito como está (novo desempate por revenue via posição no ranking é mais correto que o
antigo por ordem de cadastro; documentado no PR). IMP-5 mantém `MIN_UNIQUES_FOR_RPS = 10`
(decisão de produto do Caio) — vira recomendação de monitoramento, não mudança de código.
INF-2/INF-3 são informativos, sem ação.

### Comandos rodados (resultados reais, Round 2)
```
node -e "yaml.load(docs/openapi.yaml)" → YAML OK (+ postId parseando como objeto único)
npm run build → tsc, saída limpa, 0 erros
npm test → tsx --test $(find src -name '*.test.ts'):
  # tests 35
  # pass 35
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
```
35 = 29 (Round 1 + Argus) − 1 teste reescrito (NaN, mesma contagem) + 1 teste novo de boundary em
`rps-ranking.test.ts` + 5 novos em `interleave-by-domain.test.ts` (4 pedidos + array vazio).

### Diff final (git diff --stat, arquivos modificados)
```
 docs/openapi.yaml                      |  19 ++--
 src/controllers/redirect-controller.ts | 166 ++++++++++++++++-----------------
 src/services/pageview-service.ts       |  71 +++++++-------
```
Mais, novos e não rastreados: `src/utils/interleave-by-domain.ts`,
`src/utils/interleave-by-domain.test.ts` (além dos já existentes `rps-ranking.ts`/`.test.ts` do
Round 1). Nenhum arquivo fora do escopo comunicado pelo orquestrador (a mudança em `cron.schedule`
está dentro do próprio `redirect-controller.ts`, não em um `index.ts` separado — o cron é
inicializado em `initializeScheduledProcess`, método privado do controller).

### Riscos remanescentes para o reviewer
- IMP-5 (piso de 10 uniques estatisticamente fraco para RPS) permanece como decisão de produto
  aceita, não como bug — recomendo monitorar `[CRON-MAIN] RPS mode: ...` nos primeiros ciclos e
  considerar subir `MIN_UNIQUES_FOR_RPS` ou aplicar encolhimento bayesiano depois, se o topo do
  ranking mostrar captura por cauda de amostra pequena (ver detalhe completo em
  `agent-hera-rps.md`, seção IMP-5).
- `fetchUniqueVisitors`/`fetchBulkUniques` continuam sem teste unitário de parse (precisaria de
  mock de `fetch`, sem precedente no repo) — Argus e Hera notaram isso como lacuna aceitável, não
  bloqueante.
- Nenhuma chamada real à API de pageviews foi feita nesta rodada (mudanças são só reordenação de
  chamada + concorrência + limpeza de código morto, sem alterar o contrato de
  `fetchUniqueVisitors`).

## Stop condition (Round 2)
Atingida: todas as 10 correções aplicadas conforme decisão do orquestrador; `npm run build`
limpo; `npm test` 100% pass (35/35, incluindo os testes reescritos/adicionados); diff final
revisado — só os arquivos esperados (`redirect-controller.ts`, `pageview-service.ts`,
`docs/openapi.yaml`, mais `interleave-by-domain.ts`/`.test.ts` novos). Nenhum bloqueio.

---

## Round 3 — 4 MINORs finais da Hera, 2026-08-22

Hera aprovou o delta do round 2 (zero blockers) e apontou 4 MINORs triviais, todos aplicados:

- **N1**: guard de `computeRps` (`src/utils/rps-ranking.ts`) ganhou `!Number.isFinite(uniques)`
  — antes só `revenue` era checado contra não-finito; `uniques` NaN propagava e `uniques`
  Infinity produzia `revenue/Infinity = 0` como "RPS válido", driblando
  `MIN_UNIQUES_FOR_RPS`. 2 testes novos (`uniques NaN`, `uniques Infinity`).
- **N3**: `8` mágico do call site de `fetchBulkUniques` virou
  `private readonly RPS_UNIQUES_CONCURRENCY = 8` em `redirect-controller.ts`, ao lado de
  `MIN_UNIQUES_FOR_RPS`, com comentário do motivo (pior caso ~2,7min → ~60s).
- **N4**: `BulkPageviewItem` → `BulkUniquesItem` em `pageview-service.ts` (interface não
  exportada, uso único em `fetchBulkUniques` — grep confirmou zero outras referências).
- **N5**: 6º teste em `interleave-by-domain.test.ts` — domínio com 2 links que esgota antes de
  um domínio com 1 link vira `/random` na rodada seguinte:
  `interleaveByDomain([a:1(10), a:2(5), b:1(8)], ['a.com','b.com'])` →
  `a:1 | b:1 | a:2 | b:random`. Caso exato pedido pela Hera, passou de primeira.

**Não aplicado**: N2 (guard de sobreposição entre o cron e `POST /api/process` manual) —
confirmado fora de escopo pelo orquestrador, vira follow-up documentado no PR.

### Comandos rodados (resultados reais, Round 3)
```
npm run build → tsc, saída limpa, 0 erros
npm test → tsx --test $(find src -name '*.test.ts'):
  # tests 38
  # pass 38
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
```
38 = 35 (Round 2) + 2 testes novos de `computeRps` (NaN/Infinity em `uniques`) + 1 teste novo de
`interleaveByDomain` (domínio que esgota).

### Diff final (git diff --stat)
```
 docs/openapi.yaml                      |  19 ++--
 src/controllers/redirect-controller.ts | 171 ++++++++++++++++-----------------
 src/services/pageview-service.ts       |  73 +++++++-------
```
Mais os 4 arquivos novos não rastreados (`rps-ranking.ts`/`.test.ts`,
`interleave-by-domain.ts`/`.test.ts`). Nenhum arquivo fora do escopo.

## Stop condition (Round 3 — final)
Atingida: os 4 MINORs aplicados exatamente como especificado pela Hera; `npm run build` limpo;
`npm test` 38/38 pass. Nenhum bloqueio. Não commitado — aguardando o orquestrador seguir para
commit/push/PR.
