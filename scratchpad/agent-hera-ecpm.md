# Review Hera — Ranking por eCPM (RPS → eCPM)

**Data:** 2026-07-27 17:05
**Escopo:** `git diff` de `src/controllers/redirect-controller.ts` (10+/31-), working tree vs HEAD (`7426d01`).
**Baseline:** `backups/redirect-controller.ts.2026-07-27.bak` — verificado byte a byte contra `git show HEAD:...`, é cópia fiel do pré-mudança (arquivo é gitignored por `*.bak`).

## Veredito

**APROVADO COM RESSALVAS** — nenhum blocker. A mudança faz exatamente o que foi especificado, não tem referência morta a RPS que altere comportamento, e `npx tsc --noEmit` passa limpo (exit 0). As ressalvas são de robustez e documentação, não de correção.

## Verificações executadas

- `npx tsc --noEmit` → exit 0, sem erros.
- Grep repo-wide por `rps|RPS|uniqueVisitors|pageview` fora de `node_modules` — todos os hits restantes catalogados abaixo.
- Leitura completa dos consumidores do ranking: `getBestRpsLink` (620-674), serving `redirect` (1082-1118), serving `redirectByGroup` (1247-1281), `/api/rank` (1324-1385), `/api/rank-by-domain` (1405-1447), `/api/process` (529-564).
- Rastreio da origem de `ecpm` e `impressions`: `builder-service.ts:90-146` (`$group` + `$addFields`) e `superfilter-service.ts:70,122-124` (`preResultApi`).
- Repo não tem testes (`npm test` = "no test specified"; nenhum `*.test.ts`/`*.spec.ts`).

## O que está correto

1. Ordenação por eCPM aplicada nos dois pontos que antes usavam RPS: ranking global (`:260`) e ordem de domínios no interleave (`:441`). Não sobrou nenhuma comparação por `rps`.
2. `limitedRanking` flui direto para `validateRanking` sem quebra. `filteredRanking` é alias do mesmo array (`globalRanking.filter(...)` já é array novo), então o `sort` in-place não vaza para `globalRanking` — que depois só é usado por `.length` no log (`:256`).
3. Caminho de lista vazia é estritamente melhor que antes: com o filtro `uniqueVisitors >= 10` removido, o cenário "quase tudo cai fora → `validatedRanking.length === 0` → mantém cache anterior" praticamente desaparece. O guard em `:266` continua intacto como rede de segurança.
4. Compatibilidade dos consumidores com `rps=0`/`uniqueVisitors=0`: nenhum consumidor lê esses campos.
   - `getBestRpsLink` (`:640`) itera por índice na ordem salva — indiferente a rps.
   - Serving (`:1103`, `:1267`) é `visitIndex % length` puro.
   - `/api/rank` (`:1348-1362`) projeta só `ecpm`/`clickCount`; `sortBy` aceita `ecpm` ou clicks, nunca `rps`.
   - `/api/rank-by-domain` (`:1417-1423`) projeta só `ecpm`.
   - `/api/stats` não toca campos do ranking.
5. Entradas antigas no Redis (TTL 3600) escritas pelo código anterior carregam rps/uniques reais e o corte de 50 impressões; continuam sendo servidas até o próximo cron (≤15 min). Como ninguém lê esses campos, a coexistência é inofensiva — a shape do JSON é idêntica.
6. Sem edição fora de escopo: nenhum log, contador ou mensagem alterado além dos textos RPS→eCPM e 50→100 impressões. `skipped` continua coerente com o novo corte.

## IMPORTANTE

### I1 — Chave de ordenação tem granularidade de 0.01; desempate é correto por acidente
`src/controllers/redirect-controller.ts:230,260` + `src/services/superfilter-service.ts:122-124`

O `ecpm` que chega no controller passa por `preResultApi`, que arredonda para **2 casas** (`Math.round((revenue/impressions)*1000*100)/100`). Empates em `b.ecpm - a.ecpm` são frequentes, não raros. Hoje eles resolvem por revenue desc — mas só porque três coisas independentes se alinham: o `globalRanking.sort` por revenue em `:245`, o `.filter` de `:249` preservar ordem, e o sort do V8 ser estável. Nada disso está declarado no ponto do desempate.

**Impacto:** um refactor futuro que mova/remova o sort por revenue de `:245` embaralha silenciosamente o topo do ranking, sem erro de compilação e sem sintoma óbvio.
**Recomendação:** tornar o desempate explícito no comparador de `:260` — `(a, b) => (b.ecpm - a.ecpm) || (b.revenue - a.revenue)`.

### I2 — Comentários afirmam um invariante falso em `getBestRpsLink`
`src/controllers/redirect-controller.ts:617,639`

`"Best RPS mode: finds the highest-RPS link"` e `"Iterate ranking (already sorted by RPS descending)"`. Dois problemas: RPS não existe mais, e a lista salva no Redis **nunca** foi globalmente ordenada — é round-robin de `interleaveByDomain`. A posição 0 é o melhor eCPM global, mas a posição 1 é o melhor do segundo domínio, que pode ser pior que o segundo link do primeiro domínio. O comentário já era falso antes da mudança.

**Impacto:** é exatamente o invariante em que um mantenedor se apoiaria ao mexer em bestRpsMode.
**Recomendação:** corrigir os comentários para descrever o comportamento real — a lista é intercalada por domínio, a rodada 0 contém o melhor link de cada domínio, e portanto `getBestRpsLink` serve na prática o post de maior eCPM de cada domínio ainda não visitado nesta hora.
**Não renomear** `bestrps_*` (`:660`, `:671`) nem o logType `BEST_RPS`: esses `linkId` são a chave de `redirects_clicks` (`incrementClick` em `:1310`); renomear quebra a atribuição histórica de cliques.

### I3 — OpenAPI publicado descreve o comportamento antigo
`docs/openapi.yaml:534,1126,1133-1138` (e menções em `:8,:57,:374,:529,:1063,:1082`)

O spec é servido via swagger-ui-express. Hoje diz que `/api/process` *"calcula RPS via pageviews"* e documenta `rps` como *"Revenue per session (revenue / uniqueVisitors)"*, ambos em `required`. Os dois campos agora são sempre 0.

**Impacto:** documentação pública contradiz o payload real; quem integrar contra `RankedLink` vai assumir que `rps` significa alguma coisa.
**Recomendação:** atualizar a descrição de `/api/process` para eCPM + corte de ≥100 impressões, e marcar `rps`/`uniqueVisitors` como deprecated/sempre 0, mantidos por compat de payload.

## MÉDIO

### M1 — Corte por domínio é top-10 por revenue, mas o ranking é por eCPM
`src/controllers/redirect-controller.ts:245-254` vs `:258-260`

O post de maior eCPM de um domínio nunca entra no ranking se não estiver entre os 10 de maior revenue daquele domínio. O descasamento é pré-existente (era o mesmo com RPS), mas agora liga duas métricas que se opõem diretamente: revenue premia volume, eCPM premia taxa.
**Recomendação:** se eCPM é o objetivo, cortar o top-N por eCPM também; ou manter o corte por revenue com N maior (ex.: 20) para reduzir o viés de truncamento. Não é blocker — é para a escolha ser deliberada.

### M2 — Fan-out de validação WordPress cresceu por ordem de magnitude
`src/controllers/redirect-controller.ts:100,154,367-418,481-486`

Antes, `validateRanking` recebia a lista pós-filtro de uniques — na prática 1 domínio tinha dado de pageview, então `fetchAllValidPosts` batia em ~1 site. Agora recebe até 10 links × ~19 domínios, então **todo ciclo de cron (`*/15 * * * *`) pagina o catálogo completo de posts+pages dos 19 domínios**, 100 IDs por request, timeout de 10s cada.

Agravantes já no código: `VALID_POSTS_CACHE_TTL_MS` é 900000 (15 min) — igual ao período do cron, então o cache quase nunca ajuda; e `fetchAllValidPosts` só usa o cache quando **todos** os domínios pedidos estão presentes (`:372`), depois sobrescreve o cache inteiro com os domínios do grupo atual (`:414`) — com múltiplos grupos, isso thrasha.

**Impacto:** rajada recorrente de saída contra 19 WordPress de produção a cada 15 min. Se um site fica lento ou aplica rate-limit, os links dele são removidos (`:500-503`) e o domínio degrada para `/random`.
**Recomendação:** fazer `validPostsCache` mesclar em vez de substituir, e subir o TTL acima do período do cron (ex.: 60 min) para uma varredura WP servir 4 ciclos. É código que o diff expõe, não que o diff escreveu — follow-up, não blocker.

### M3 — Ruído estatístico no piso de 100 impressões
`src/controllers/redirect-controller.ts:224`

Com `ecpm = revenue/impressions × 1000`, um post com exatamente 100 impressões e uma única impressão de alto valor produz um eCPM de topo. Combinado com I2: em bestRpsMode a rodada 0 cobre todos os domínios, então `getBestRpsLink` serve **exatamente o post nº 1 em eCPM de cada domínio** — uma estimativa ruidosa captura todo o tráfego bestRps daquele domínio na hora.
**Recomendação** (sem re-litigar a decisão de produto): monitorar se o post de maior eCPM por domínio tem contagem de impressões perto do piso. Se tiver, considerar piso maior para os slots de topo, encolhimento (shrinkage) do eCPM em direção à média do domínio, ou um piso mínimo de revenue.

## BAIXO / NIT

- **B1 — `src/controllers/redirect-controller.ts:259`:** `const filteredRanking = limitedRanking;` é alias puro; nada é filtrado. Renomear para `rankedByEcpm` (ou ordenar `limitedRanking` direto) deixa `:263`/`:266` legíveis.
- **B2 — `src/controllers/redirect-controller.ts:230`:** `parseFloat(String(item.ecpm || 0))` pode render `NaN` (`IProcessedData.ecpm?: number | string`, `filter-interfaces.ts:47`). Antes o campo era só display; agora é a chave do sort, e um comparador que retorna `NaN` corrompe a ordenação do array inteiro, não só do elemento. Probabilidade baixa (a agregação sempre emite número), custo do guard é uma expressão: `Number.isFinite(x) ? x : 0`.
- **B3 — `src/services/pageview-service.ts`:** ficou sem nenhum importador. O arquivo também tem uma chave de API hardcoded na URL (`:1`, `.../report-all/0f99f85f-…`) — pré-existente, mas deletar o arquivo morto remove uma credencial versionada de graça. Se for mantido para revival futuro, vale um comentário no topo dizendo que está desconectado do fluxo.
- **B4 — `src/controllers/redirect-controller.ts:181`:** docstring ainda lista `uniqueVisitors, rps` no shape do Redis sem dizer que são sempre 0. Tecnicamente verdadeiro, enganoso na prática.

## Coverage gaps

O repo não tem infraestrutura de teste: `npm test` é `echo "Error: no test specified" && exit 1`, e não existe nenhum `*.test.ts`/`*.spec.ts`. Não há teste a atualizar — cobrar suíte aqui seria desproporcional ao diff.

Verificação feita: `npx tsc --noEmit` limpo.

Verificação manual sugerida antes/depois do deploy: rodar `GET /api/process?slug=main` no ambiente alvo e depois `GET /api/rank-by-domain`, contando entradas com `postId === "random"` — esperado cair de ~47/50 para perto de 0. **Atenção:** `/api/process` reescreve o cache de ranking no Redis, então deve ser rodado com consciência disso, não como sonda inócua.

## Padrões observados

- O pipeline de `executeProcessForGroup` acumula invariantes implícitos entre statements distantes (sort por revenue em `:245` sustentando o desempate em `:260`; ordem do interleave sustentando a semântica de `getBestRpsLink`). Cada mudança pontual nele é barata; o risco está em não haver nada no código que declare essas dependências.
- Nomenclatura histórica (`bestrps_`, `BEST_RPS`, `getBestRpsLink`) virou dívida de nome com valor de chave: não pode ser renomeada sem quebrar atribuição de clique. Vale tratar como nome congelado e documentar isso, em vez de deixar o próximo agente "limpar".

## Memórias relacionadas

- `2026-07-27_17-00_ecpm-ranking-implementacao.md` (Athena — implementação)
- `2026-05-12_16-00_review-utm-term-fix-hera.md` (review anterior neste repo)

---

# Round 3 — M1 + M2 aplicados

**Escopo:** `git diff` de `src/controllers/redirect-controller.ts` vs HEAD `9f2a8e4` (59+/30-). Round 1/2 já commitados.

## Veredito: **BLOQUEADO**

Um defeito de corretude introduzido pelo M2: **com múltiplos grupos, todos os grupos exceto o primeiro deixam de revalidar seus domínios no WordPress — permanentemente.** Não é teórico: `main` (14 domínios) e `db` (5) são disjuntos (`src/config/domains.ts:1-28`), então o grupo `db` é atingido em produção. `npx tsc --noEmit` passa (exit 0), M1 está correto, e o resto do M2 está bem feito — o bloqueio é sobre um único ramo.

## BLOCKER

### BL1 — Grupos após o primeiro nunca mais revalidam posts no WP
`src/controllers/redirect-controller.ts:417,422-425,446`

O `validPostsCacheTime` é **um só, global para todo o cache** (`:99`), mas agora o cache guarda domínios de todos os grupos ao mesmo tempo (esse é justamente o ponto do merge). O grupo que dispara a expiração — `main`, primeiro na iteração de `executeAllGroups:170-176` — refaz o fetch pelo ramo expirado e reseta `validPostsCacheTime = now` (`:446`). Todo grupo processado depois, na mesma passada, encontra `cacheIsFresh === true` e `missingDomains.length === 0`, e sai pelo early return de `:422-425`. Como o timestamp é único, **`db` nunca consegue observar as próprias entradas como expiradas**.

Simulação da lógica exata de `:415-449` com os domínios reais, cron de 15 min, TTL 60 min:

```
t(min) | grupo | domínios efetivamente buscados na API
     0 | main  | 14 domínios
     0 | db    | 5 domínios
    15..45 | (ambos) | nenhum — cache      ← comportamento desejado do M2
    60 | main  | 14 domínios
    60 | db    | (nenhum — cache)
   120 | main  | 14 domínios
   120 | db    | (nenhum — cache)
   180 | main  | 14 domínios
   180 | db    | (nenhum — cache)

Idade das entradas em t=180min:  main: 0min   db: 180min
```

As 5 entradas de `db` congelam no valor buscado no boot e envelhecem indefinidamente — o processo é long-lived (cluster, só reinicia em deploy), então na prática são dias.

**Impacto:** posts deletados/despublicados em `forexmania.club`, `netseguro.tech`, `techerdowns.com`, `creditoclube.com.br` e `dicasdocartao.com.br` continuam sendo servidos (302 para 404), e posts publicados depois do boot nunca entram no ranking de `db`. É exatamente o que `validateRanking` existe para impedir. É **regressão**: antes do M2 cada grupo refazia o fetch todo ciclo (o thrash que o M2 veio corrigir), então a freshness nunca falhava. Só se manifesta depois de 1h+ de uptime, então não aparece em smoke test.

**Recomendação:** trocar o timestamp global por **timestamp por domínio** — `Map<string, { result: FetchPostIdsResult; fetchedAt: number }>` — e calcular a expiração por entrada. Assim `missingDomains` vira "ausente **ou** expirado", `validPostsCacheTime` deixa de existir, e some junto o refetch prematuro descrito em BX3. Precedente no próprio arquivo: `bestLinksMapCaches` já usa `Map<string, { data; time }>` com TTL por chave (`:86-87`).

## IMPORTANTE

### I1 — M1 removeu a última proteção implícita contra eCPM de baixa amostra, e o M3 não foi aplicado
`src/controllers/redirect-controller.ts:224,247-256`

O corte por revenue funcionava como filtro de volume não intencional: o pool de candidatos de cada domínio era enviesado para posts de muita impressão. Com o corte agora por eCPM, o pool passa a ser os 10 maiores eCPM do domínio — que tendem estruturalmente ao piso de 100 impressões, porque denominador pequeno produz eCPM extremo. Concretamente: um post com 100 impressões e R$0,50 (eCPM 5,00) agora toma a vaga de um com 50.000 impressões e R$100 (eCPM 2,00).

Compondo com o interleave (rodada 0 = melhor link de cada domínio) e com bestRpsMode servindo exatamente a rodada 0, **a estimativa mais ruidosa de cada domínio captura todo o tráfego bestRps daquele domínio na hora**.

Isso é a semântica pretendida de "ranquear por eCPM" e foi aprovado pelo usuário — o ponto é que o perfil de risco mudou materialmente entre o round 2 e o round 3, e o M3 ficou mais relevante, não menos.
**Recomendação:** depois da primeira passada do cron, conferir a contagem de impressões do link nº 1 de cada domínio (log do top-5 do cron / `/api/rank-by-domain`). Se ficarem agrupadas perto de 100, o M3 (piso maior para os slots de topo, shrinkage do eCPM para a média do domínio, ou piso mínimo de revenue) passa de débito documentado a necessário.

## BAIXO / NIT

- **BX1 — `:424` vs `:438`/`:448`:** o ramo de cache completo devolve a **referência viva** de `this.validPostsCache` (superset com domínios de outros grupos), enquanto os outros dois ramos devolvem mapas privados. Nenhum consumidor hoje muta o retorno (`validateRanking:490-515` só lê) e o superset é inerte para o `.get(link.domain)`, então não há bug — mas é aliasing inconsistente, e quem mutar o retorno corrompe o cache só nesse ramo. Devolver mapa novo nos três caminhos, ou documentar o retorno como read-only.
- **BX2 — `:261`:** o segundo sort é **no-op**. `limitedRanking` vem de um `.filter` (preserva ordem) sobre um array já ordenado pelo comparador idêntico de `:247` — não há como mudar a ordem. É barato (≤190 itens a cada 15 min), mas o comentário "Reafirma o mesmo critério do corte acima — mantém o invariante explícito" promete uma garantia que ele não entrega: se alguém mudar o comparador de `:247`, este sort faz a **ordenação** discordar em silêncio do **critério do corte** — que é precisamente o defeito M1 que a rodada veio consertar, agora mascarado em vez de exposto. Ou remover e dizer que a ordem é herdada de `globalRanking`, ou manter com um comentário que descreva a garantia real (o interleave exige ordem eCPM-desc independentemente de como o corte foi feito).
- **BX3 — `:427-438`:** o ramo "cache fresco + faltantes" não mexer em `validPostsCacheTime` está **correto** — é a escolha conservadora. Atualizar ali seria ativamente pior: estenderia a janela de frescor de todas as entradas antigas sempre que um domínio novo aparecesse, permitindo que um domínio vivesse indefinidamente sem refetch. O custo da escolha atual é refetch prematuro limitado (domínio buscado em t=59min é rebuscado em t=60min), nunca staleness ilimitada. Some sozinho com o timestamp por domínio de BL1.
- **BX4 — `:442-446`:** chamada com `domainsToCheck` vazio cairia no ramo expirado, não buscaria nada e ainda assim faria `validPostsCacheTime = now`, resetando o relógio global de graça. Hoje é inalcançável pelo guard de `validateRanking:484`, mas o timestamp global ficou load-bearing — some junto com BL1.
- **BX5 — `:429-431`, `:443-445`:** o cache agora só cresce; nada é despejado. Um domínio removido de um grupo mantém para sempre seu `Set` de IDs (todos os posts+pages do site). Churn de domínio é baixo e o processo reinicia em deploy, então é aceitável — mas vale prever poda das entradas que não pertencem a nenhum grupo ativo.
- **BX6 — `:374-379`:** não há dedup de fetch em voo. `/api/process` (`:529-564`) é rota pública e pode rodar concorrente com o cron, duplicando o fan-out contra os WordPress — o oposto do objetivo do M2. Precedente de single-flight no próprio repo: `domain-group-service.ts:83-101`.
- **BX7 — `:423`:** o log informa `this.validPostsCache.size`, que sob merge é o total de **todos os grupos**, não os domínios deste request. Número passa a enganar na leitura do log.

## Respostas diretas às perguntas do round

1. **Corretude do merge:** correta nos três caminhos. Todo domínio pedido está no Map retornado sempre que a promise resolveu — e `fetchValidPostIds:339-359` envolve o corpo inteiro em try/catch, então rejeição é praticamente inalcançável; se ocorresse, o domínio fica de fora e `validateRanking:494-497` remove os links dele, que é o comportamento pré-existente. O fallback foi preservado e ficou **melhor**: `fallbackCache` é o cache que agora retém entradas indefinidamente, então um domínio com API falhando reaproveita os últimos IDs bons por muito mais tempo. Confirmado também que um refetch falho **nunca** rebaixa uma entrada boa (`:385-395` só grava a falha quando não há entrada bem-sucedida em cache). Sem race entre grupos: `executeAllGroups:170-176` roda sequencial com `await`, e o consumo em `validateRanking` é um `.filter` síncrono sobre um mapa já resolvido, então nenhuma mutação cai no meio da filtragem.
2. **Semântica de `validateRanking`:** intacta — `:481-521` não foi tocado, domínio ausente do mapa continua removendo os links.
3. **Timestamp no ramo parcial:** a escolha está certa e é a conservadora (ver BX3). O problema não está nesse ramo, e sim no ramo vizinho: o early return de `:422-425` combinado com o timestamp único é o que produz BL1.
4. **M1:** interage bem com o corte — o post de maior eCPM do domínio agora sempre entra. O sort final virou no-op (BX2). A consequência não-óbvia relevante é I1.
5. **`fetchDomainsFromApi`:** extração fiel, escopo mínimo. Comparado ao código inline anterior, a única mudança substantiva é `previousCache` → parâmetro `fallbackCache`; logs, `Promise.allSettled` e os ramos de fallback são idênticos em comportamento. Nenhum comportamento novo. Sem finding.
6. **Verificação:** `npx tsc --noEmit` → exit 0. Fora de escopo: nada — o diff toca só `redirect-controller.ts` e o scratchpad da própria Athena; nenhum log, contador ou mensagem alterado além dos dois comentários e das linhas de log do cache (a nova linha de `:427` é pertinente e está no escopo).

## Coverage gaps (round 3)

Repo continua sem infraestrutura de teste. BL1 é exatamente o tipo de defeito que um teste unitário pegaria de graça — a lógica de `fetchAllValidPosts` é pura o suficiente para ser exercitada com um relógio fake e um `fetchValidPostIds` stubado, e a simulação acima é essencialmente esse teste escrito fora do repo. Se em algum momento entrar suíte de teste neste projeto, este é o primeiro caso que vale escrever: dois grupos disjuntos, N ciclos de cron, assertar que toda entrada é revalidada dentro do TTL.

---

# Round 4 — fix do BL1 + nits

**Escopo:** diff cumulativo (round 3 + 4) de `src/controllers/redirect-controller.ts` vs HEAD `9f2a8e4`.

## Veredito: **APROVADO COM RESSALVAS**

O blocker está morto — verificado por construção e por simulação. As ressalvas que restam são uma amplificação de risco pré-existente (I2 abaixo, a mais relevante) e dívida de observabilidade; nenhuma bloqueia o merge.

## BL1 — RESOLVIDO

`:58-61` (`ValidPostsCacheEntry`), `:108` (cache com entrada tipada), `:430-434` (expiração por entrada), `:439` (gravação com `fetchedAt`).

`validPostsCacheTime` foi removido por completo — `grep -rn "validPostsCacheTime\|previousCache\|allCached" src/` não retorna nada, então não sobrou nenhum relógio compartilhado nem código morto da lógica antiga. `missingDomains` agora é "ausente **ou** `(now - entry.fetchedAt) >= TTL`", avaliado domínio a domínio, então não existe caminho onde uma entrada presente-mas-expirada escape do refetch: a única porta de saída sem fetch é `missingDomains.length === 0`, que por definição significa que toda entrada pedida está dentro do TTL.

Simulação da lógica nova, mesmos grupos e ciclos do round 3:

```
t=0    main 14 | db 5        ← boot
t=15/30/45   ambos: cache    ← ganho do M2 preservado (4 de 5 ciclos sem fetch)
t=60   main 14 | db 5        ← db revalida (antes: nunca)
t=120  main 14 | db 5
t=180  main 14 | db 5

24h de ciclos — idade máxima observada: main=60min, db=60min (TTL=60min)
```

Nenhuma entrada ultrapassa o TTL em 24h, nos dois grupos. O cenário que produzia o congelamento permanente de `db` está fechado.

## IMPORTANTE

### I2 — Paginação truncada é tratada como sucesso, e o TTL de 60 min quadruplicou a janela de envenenamento
`src/controllers/redirect-controller.ts:324-342` (lógica pré-existente) + `:109`, `:439` (amplificação desta mudança)

`fetchIdsFromEndpoint` marca `atLeastOneSuccess = true` assim que a **primeira** página responde OK (`:329`); se uma página seguinte devolver não-OK, o loop apenas dá `break` (`:324-327`) e a função retorna `true`. `fetchValidPostIds` então entrega `{ success: true, ids: <conjunto truncado> }`, e `validateRanking` remove todo link cujo `postId` não esteja nesse conjunto parcial. Como a query usa `orderby=date&order=desc`, o conjunto truncado são os posts **mais novos** — e os posts que aparecem no ranking são os que faturam, com frequência antigos. Um único HTTP 429 na página 2 pode derrubar a maior parte dos links de um domínio para `/random`.

O comportamento é pré-existente e nenhum dos quatro rounds tocou nele. O que mudou é a **persistência**: sob o TTL antigo de 15 min o conjunto truncado se auto-curava no ciclo seguinte; com `:109` em 60 min e `:439` gravando esse resultado como entrada boa, ele fica autoritativo por uma hora. Isso interage diretamente com a motivação do próprio M2 — a varredura completa dos 19 catálogos é justamente o tipo de carga que provoca rate limit, e agora cada rate limit gruda 4× mais tempo.

**Recomendação (follow-up, fora do escopo desta rodada):** tratar interrupção de paginação como falha — retornar `success: false` quando o loop quebrar por resposta não-OK em qualquer página, deixando o caminho de fallback preservar o conjunto bom anterior. O sucesso só deveria ser declarado quando o loop termina limpo (`items.length < perPage` ou lista vazia). Alternativa mínima: não gravar em cache resultado cuja paginação não terminou limpa.

## MÉDIO

### M4 — `fetchedAt = now` no fallback-por-falha faz o campo mentir, e a cadeia de fallback não tem teto nem alarme
`src/controllers/redirect-controller.ts:398`, `:439`

Respondendo diretamente à pergunta do round: **o backoff em si está certo.** Não re-tentar um site caído a cada 15 min é a escolha defensável, e o custo de re-tentar seria baixo mas o benefício também — um site fora do ar raramente volta em 15 min, e a alternativa (entrada permanece expirada, retry todo ciclo) não traz ganho proporcional.

O problema não é o trade-off, é o que o campo passa a significar. Quando a API falha e o fallback reusa `fallbackCache.get(domain)?.result` (`:398`), `fetchAllValidPosts` grava esse resultado **antigo** com `fetchedAt: now` (`:439`). A partir daí `fetchedAt` não é mais "quando estes IDs vieram do WordPress", e sim "quando decidimos mantê-los" — e nada distingue os dois casos. Consequência: um site fora do ar por 12 horas carrega o mesmo conjunto de IDs do boot por 12 renovações, cada uma carimbada como recente. A idade real do dado é ilimitada enquanto a entrada se apresenta como fresca, e o único sinal é um `console.log` por hora no meio do log do cron (`:400`), fácil de não ver.

**Recomendação:** separar os dois relógios — manter `fetchedAt` como "último fetch bem-sucedido no WP" e adicionar um `lastAttemptAt` para governar o backoff; ou, se preferir manter uma coisa só, contar as reutilizações consecutivas do fallback e escalar para `console.warn` a partir da segunda, para que um domínio persistentemente caído apareça no log em vez de congelar em silêncio. O comportamento de backoff pode ficar como está.

## Nits do round 3 — status

- **BX1 (aliasing) — corrigido.** `:441-445` monta um Map novo a cada chamada, em todos os caminhos; a referência viva do cache nunca sai do método.
- **BX2 (sort no-op) — resolvido como recomendado.** O comentário de `:270` agora descreve a garantia real ("o interleave exige ordem eCPM-desc; este sort garante isso independentemente do critério usado no corte") em vez de prometer uma reafirmação que não se sustentava. O sort continua sendo no-op hoje, mas agora está documentado como defesa do requisito do interleave, que é correto.
- **BX3 (timestamp do ramo parcial) — obsoleto**, some junto com o timestamp global.
- **BX4 (lista vazia resetando o relógio) — obsoleto** pelo mesmo motivo: sem relógio global, chamada vazia é inócua (`missingDomains` vazio, retorna Map vazio).
- **BX7 (log) — corrigido.** `:437` reporta os domínios do request; a linha de fetch (`:436`) informa quantos foram buscados e quantos vieram do cache.
- **BX5 (cache só cresce) — permanece.** Nenhuma entrada é despejada; domínio removido de um grupo mantém para sempre seu `Set` de IDs. Segue aceitável (churn baixo, processo reinicia em deploy).
- **BX6 (sem single-flight) — permanece.** `/api/process` concorrente com o cron ainda duplica o fan-out; precedente em `domain-group-service.ts:83-101`.

## I1 do round 3 — em aberto

O ruído de eCPM de baixa amostra (M3) continua não endereçado: com o corte agora por eCPM, o pool de cada domínio tende ao piso de 100 impressões, e o bestRpsMode serve exatamente a rodada 0 do interleave. Não é defeito de código — é a decisão de produto já aprovada. Mantida a recomendação de conferir as impressões do link nº 1 de cada domínio depois da primeira passada do cron.

## Verificação (round 4)

- `npx tsc --noEmit` → exit 0.
- `grep -rn "validPostsCacheTime\|previousCache\|allCached" src/` → sem resultados; nenhum resquício da lógica antiga.
- Tipos consistentes: `ValidPostsCacheEntry` (`:58-61`) usado só no cache e no parâmetro `fallbackCache` (`:381`); `fetchDomainsFromApi` e `fetchAllValidPosts` seguem devolvendo `Map<string, FetchPostIdsResult>`, então `validateRanking` (consumidor) não precisou mudar e não mudou.
- Simulação da lógica nova (acima) confirmando revalidação de todos os grupos dentro do TTL.
- Fora de escopo: nada. O diff cumulativo toca só `redirect-controller.ts` e os scratchpads; `validateRanking`, `interleaveByDomain`, `getBestRpsLink` e todo o caminho de serving seguem intactos.
- Detalhe sem finding: `fetchedAt: now` usa o `now` capturado **antes** do await (`:428`), então entradas ficam marcadas como levemente mais velhas do que são quando a varredura demora. É o lado conservador do erro (expira mais cedo), então está certo.

---

# Round 5 — I2 (tri-state) + M4 (alarme de fallback)

**Escopo:** verificação final pré-commit do diff cumulativo (rounds 3+4+5) de `src/controllers/redirect-controller.ts` vs HEAD `9f2a8e4` — 146+/64-.

## Veredito: **APROVADO COM RESSALVAS — pode commitar**

I2 e M4 estão corretos e resolvem o que se propuseram. As ressalvas abaixo são de robustez; a mais relevante (I3) é herdada do round 4, mas o I2 aumentou muito a chance de ela disparar, então vale como próximo fix — de preferência antes do próximo deploy, já que deploy cria cache frio por definição.

## I2 — correto

Tabela verdade de `fetchValidPostIds:392-394` conferida caminho a caminho:

| posts | pages | success | correto? |
|---|---|---|---|
| clean | clean | ✅ | sim |
| clean | failed | ✅ | sim — endpoint ausente desde a página 1 é tolerado, nem todo site expõe `/pages` |
| clean | truncated | ❌ | **sim — é o fix**: conjunto parcial não vira mais autoritativo |
| failed | failed | ❌ | sim |
| failed | truncated | ❌ | sim |
| truncated | truncated | ❌ | sim |

`'truncated'` não vaza como sucesso em nenhuma combinação. Os retornos de `fetchIdsFromEndpoint` cobrem todos os caminhos do loop: não-OK na página 1 (`:341-343`), 400 em página > 1 (`:344-347`), demais não-OK em página > 1 (`:348-349`), corpo vazio (`:354`), última página parcial (`:360`), exceção na página 1 (`:363-366`) e exceção depois (`:367-368`).

**Sobre o caso que o round pediu para checar** (site quebrado respondendo 400 direto na página 1): cai em `'failed'` corretamente — o `if (page === 1)` de `:341` é avaliado **antes** do `if (response.status === 400)` de `:344`, então o 400 só é interpretado como fim de catálogo onde essa interpretação faz sentido. A leitura do WordPress também está certa: `rest_post_invalid_page_number` é 400, e o cenário de catálogo com exatamente 100 posts (página 1 cheia → página 2 devolve 400 → `'clean'`) funciona como a Athena descreveu.

Mover o try/catch para dentro de `fetchIdsFromEndpoint` foi a decisão certa: o `.catch(() => false)` anterior apagava justamente a informação (quantas páginas já haviam sido lidas) necessária para separar 'failed' de 'truncated'.

## M4 — funciona; validado por simulação

Simulei a lógica de `:477-490` com cache quente e WP caindo a partir de t=60:

```
t=0    fetch → clean          | links ok
t=60   fetch → FALLBACK       | links ok
t=120  fetch → FALLBACK       | links ok  ⚠ WARN: 2 fallbacks seguidos (~2h)
t=180  fetch → FALLBACK       | links ok  ⚠ WARN: 3 fallbacks seguidos (~3h)
t=240  fetch → FALLBACK       | links ok  ⚠ WARN: 4 fallbacks seguidos (~4h)
```

A interação I2×M4 pedida no round está correta: endpoint truncado → `success:false` → ramo de fallback → contador incrementa → warn a partir da 2ª renovação seguida, escalando a cada ciclo. O `staleHours` bate com a idade real dos dados. O contador zera em fetch novo (sucesso **ou** falha sem cache utilizável), que é o comportamento desejado — ele existe para sinalizar "domínio servindo IDs velhos", e falha sem cache não serve IDs velhos, serve `/random`, que já tem `console.warn` próprio em `:441`.

## IMPORTANTE

### I3 — Falha em cache frio fica pinada por 60 min, e o I2 tornou isso muito mais alcançável
`src/controllers/redirect-controller.ts:477-490` (sem guard de `success` no `.set`)

O loop grava no cache **tudo** que `fetchDomainsFromApi` devolveu, inclusive `{ success: false }` do ramo "sem cache anterior" (`:441`), com `fetchedAt: now` cheio. Como `missingDomains` (`:470-473`) só reconsidera entradas expiradas, uma falha em cache frio não é re-tentada por 60 minutos — e `validateRanking` remove todos os links do domínio em cada ciclo desse intervalo.

Simulação (cache frio de deploy, domínio truncado só no boot, WordPress saudável a partir de t=1min):

```
t=0   fetch → FALHA s/ cache          | links REMOVIDOS (/random)
t=15  sem fetch (entrada fresca)      | links REMOVIDOS (/random)
t=30  sem fetch (entrada fresca)      | links REMOVIDOS (/random)
t=45  sem fetch (entrada fresca)      | links REMOVIDOS (/random)
t=60  fetch → clean                   | links ok
```

Quatro ciclos de cron — uma hora inteira de `/random` — para um domínio cujo WordPress se recuperou um minuto depois do boot.

O comportamento vem do round 4, mas o I2 mudou a probabilidade: antes só uma falha total dos dois endpoints marcava `success:false`; agora qualquer truncamento no meio da paginação também marca. E o cenário mais provável de truncamento é exatamente o boot, quando `initializeScheduledProcess:149` dispara `executeAllGroups` e os 19 catálogos são varridos de uma vez — o burst que pode provocar o próprio rate limit. Deploy em horário de pico + um domínio truncado = aquele domínio em `/random` por uma hora.

**Recomendação:** não cachear resultado com `success: false` quando não houve fallback — ou simplesmente não dar `.set` nesse caso (o domínio volta a `missingDomains` no ciclo seguinte, re-tentando em 15 min), ou gravar falhas com um TTL de retry curto e separado do TTL de sucesso. O `.set` do fallback e do sucesso continuam como estão.

## MÉDIO

### M5 — A detecção de fallback depende de identidade de referência, sem aviso no lado que pode quebrá-la
`src/controllers/redirect-controller.ts:482` (consumidor) e `:437` (produtor)

`previousEntry.result === fetchResult` só é verdadeiro porque `fetchDomainsFromApi` faz `result.set(domain, cached)` com o **mesmo objeto** vindo de `fallbackCache.get(domain)?.result` (`:436-437`). O invariante está correto hoje e existe comentário no ponto do teste (`:481`) — mas **não existe nada em `:437`** avisando que a identidade daquela referência é load-bearing. Uma limpeza futura perfeitamente razoável em `fetchDomainsFromApi` (clonar para evitar estado mutável compartilhado, normalizar o resultado, `result.set(domain, { ...cached })`) torna a comparação falsa para sempre: o contador nunca mais incrementa e o warn nunca mais dispara, **sem erro de compilação e sem sintoma** — o pior modo de falha possível para um alarme.

É o mesmo padrão que já apontei duas vezes neste arquivo (round 2 "padrões observados", e BX2 no round 3): invariante implícito sustentado a distância.

**Recomendação:** tornar o sinal explícito — `fetchDomainsFromApi` devolver `Map<string, { result: FetchPostIdsResult; fromFallback: boolean }>` e `fetchAllValidPosts` ler a flag em vez de comparar referências. Se preferirem manter a identidade, o mínimo é um comentário em `:437` dizendo que aquele objeto não pode ser clonado porque `fetchAllValidPosts` usa a identidade dele para detectar fallback.

### M6 — `!Array.isArray(items)` declara `'clean'` com conjunto vazio/parcial
`src/controllers/redirect-controller.ts:354`

`if (!Array.isArray(items) || items.length === 0) return 'clean';` funde dois casos diferentes: array vazio de verdade (fim legítimo do catálogo) e **corpo que não é array** (resposta inesperada com HTTP 200). No segundo caso o endpoint é declarado limpo com os IDs coletados até ali — na página 1, um conjunto vazio; em página > 1, um conjunto parcial. Se isso acontecer na página 1 e o outro endpoint também não contribuir, o domínio vira `success: true` com 0 IDs, e `validateRanking` trata 0 IDs como "domínio sem conteúdo" e remove todos os links — agora cacheado como sucesso por 60 minutos.

Reconhecimento honesto da probabilidade: baixa. Corpo HTML (interstitial de WAF/CDN, modo manutenção) faz `response.json()` lançar, e isso já cai no catch como 'failed'/'truncated'. O furo é o JSON válido que não é array — objeto de erro do WP ou de plugin devolvido com 200. É o último ponto onde `'clean'` pode ser declarado sem catálogo completo, num tri-state que ficou rigoroso em todo o resto.

**Recomendação:** separar os casos — `'failed'` se `page === 1`, `'truncated'` se `page > 1`, reservando `'clean'` para array de verdade (inclusive vazio).

## NIT

- **`:486`** — o warn diz "defasados em até ~Xh", mas `consecutiveFallbacks × TTL` é **piso**, não teto: entre renovações passa no mínimo o TTL, e como o cron é de 15 min o intervalo real fica entre 60 e 75 min. O texto certo é "pelo menos ~Xh". Subestimar defasagem numa mensagem que alguém vai ler durante um incidente erra para o lado errado.
- **`:403`** — o try/catch externo de `fetchValidPostIds` virou inalcançável: `fetchIdsFromEndpoint` agora captura tudo internamente e nunca rejeita, e `Promise.all` de duas promises que não rejeitam não rejeita. Seguro deixar como está; só não conta mais como proteção real.
- **`:334`** — `while (true)` sem teto de páginas. Um site que ignore o parâmetro `page` e devolva sempre 100 itens gera loop infinito de fetches de 10s. Pré-existente e não introduzido aqui, mas o loop foi reescrito nesta rodada, então é o momento barato de pôr um `MAX_PAGES`.

## Verificação final (pré-commit, rounds 3+4+5)

- `npx tsc --noEmit` → exit 0.
- `git diff --stat` → apenas `src/controllers/redirect-controller.ts` (146+/64-) e os dois scratchpads. Nada fora de escopo.
- `validateRanking`, `interleaveByDomain`, `getBestRpsLink`, `/api/rank`, `/api/rank-by-domain` e todo o caminho de serving seguem intactos desde o round 1.
- Simulações de `fetchAllValidPosts` (rounds 4 e 5) confirmando revalidação dentro do TTL em todos os grupos, escalada correta do warn, e o comportamento de cache frio descrito em I3.

## Débito em aberto ao fim dos 5 rounds

I3 (falha pinada por 60 min) e M5 (invariante de referência) são os que eu pegaria primeiro. Seguem também: M6, os nits acima, BX5 (cache sem poda), BX6 (sem single-flight) e I1/M3 (ruído de eCPM de baixa amostra no piso de 100 impressões — decisão de produto já aprovada, monitorar as impressões do link nº 1 de cada domínio depois da primeira passada do cron).

---

# Round 6 — fix do I3

**Escopo:** diff incremental vs HEAD `8d7c3d3` (rounds 3-5 já commitados) — 16+/1- em `src/controllers/redirect-controller.ts`.

## Veredito: **APROVADO**

O fix é mínimo, faz exatamente o que foi recomendado e está correto nos quatro caminhos. Só findings LOW abaixo, e o débito em aberto é o mesmo do round 5 — nada novo introduzido.

## I3 — RESOLVIDO

`:484-494` (guard) e `:479-505` (loop de gravação).

Simulação do comportamento novo (cache frio, WP quebrado até t=45, saudável a partir de t=46):

```
t=0   FETCH falhou → NÃO persistido (retry no próx. ciclo) | ausente → removedByFailure
t=15  FETCH falhou → NÃO persistido                        | ausente → removedByFailure
t=30  FETCH falhou → NÃO persistido                        | ausente → removedByFailure
t=45  FETCH falhou → NÃO persistido                        | ausente → removedByFailure
t=60  FETCH ok → persistido                                | links ok
t=75  sem fetch (entrada fresca)                           | links ok
```

O domínio volta a `missingDomains` a cada ciclo e se recupera no primeiro cron saudável, em vez de ficar pinado 60 min. O cenário do round 5 (recuperação 1 min após o boot custando uma hora de `/random`) está fechado.

## Q1 — a equivalência do Map retornado é real

`fetchAllValidPosts` tem **um único consumidor**: `validateRanking:585` (confirmado por grep em `src/`; nenhum outro caminho lê `validPostsCache` fora dos próprios métodos do cache). Lá, `!result` e `!result.success` caem no mesmo par de linhas (`removedByFailure++; return false;`), então ausente e presente-falho são de fato indistinguíveis para o serving. Equivalência confirmada.

## Q2 — os quatro caminhos, e uma correção à hipótese do round

Todos corretos:

| caminho | `success` | `isFallbackReuse` | resultado |
|---|---|---|---|
| fetch novo com sucesso | true | false | persiste, contador zera ✓ |
| fallback reuse | true | true | persiste, contador incrementa, warn ≥2 ✓ |
| falha sem fallback | false | false | `continue`, não persiste, retry em 15 min ✓ |
| falha com entrada boa **expirada** | true | true | fallback normal — a expiração não importa, `fallbackCache` é o cache inteiro ✓ |

**Sobre o alcance do M5 ter crescido: não cresceu, e vale corrigir a hipótese.** `isFallbackReuse` só pode ser `true` quando `fetchResult` veio do ramo de fallback de `fetchDomainsFromApi:436`, que exige `cached.success && cached.ids.size > 0` — ou seja, `isFallbackReuse ⟹ success === true`. Logo, no guard `if (!fetchResult.success && !isFallbackReuse)`, a cláusula `&& !isFallbackReuse` nunca altera o resultado: o termo decisivo é `!fetchResult.success`, que lê um **campo real**, não uma identidade.

Consequência prática: se alguém clonar o objeto em `fetchDomainsFromApi` (o cenário exato do M5), o resultado do fallback continua carregando `success: true`, então continua sendo persistido e **o retry de 15 min não quebra**. O que quebra é só o que o M5 já dizia — o contador e o warn param em silêncio. M5 segue MÉDIO, com o mesmo alcance e a mesma recomendação (sinal explícito `{ result, fromFallback }`, ou comentário em `:437`).

A cláusula redundante é defensável como blindagem futura: se um dia o ramo de fallback for relaxado para reaproveitar entrada falha, o guard já estaria correto. Só registro que ela *lê* como se a identidade sustentasse o retry, quando não sustenta — o comentário de `:485-492` explica bem a intenção, então não vira finding.

## Q3 — o edge case da Athena: aceitável, com uma ressalva de diagnóstico

Confirmado por simulação (entrada antiga `success:true` com 0 IDs, WP falhando sempre):

```
t=0..90  FETCH falhou → NÃO persistido (retry no próx. ciclo) | success:true/0 IDs → invalidCount (!)
```

O `continue` pula o `.set` mas **não remove** a entrada antiga, e o builder do retorno (`:512-515`) a lê do cache e a devolve. Como ela tem `ids.size === 0`, `validateRanking` cai no ramo de `invalidCount` em vez de `removedByFailure`.

Do ponto de vista de serving é equivalente — os links do domínio são removidos nos dois casos, então aceitável como está. A ressalva é de diagnóstico: durante um incidente o log diz `N links removidos por post inexistente` quando a causa real é API falhando, apontando o operador para o lado errado. A entrada também nunca envelhece para fora do mapa (soma-se ao BX5).

**Recomendação (LOW):** no caminho do `continue`, remover a entrada existente quando ela não puder servir de fallback (`!success || ids.size === 0`). Ela não tem utilidade — o ramo de fallback já a rejeita — e removê-la faz o domínio reportar corretamente como `removedByFailure` e para de ocupar o mapa. Não há perda: um domínio legitimamente vazio volta a ser buscado no ciclo seguinte, que é o correto quando não se tem dado utilizável.

## LOW

- **L1 — atribuição de log no edge case acima** (`:484-494` + `validateRanking`): descrito em Q3.
- **L2 — domínio permanentemente quebrado não tem backoff nem escalada** (`:441`, `:484-494`): sem cache utilizável, ele passa a ser re-tentado a cada 15 min indefinidamente, com um `console.warn` plano por tentativa (4/hora em vez de 1/hora). A divisão retry-rápido-sem-cache / backoff-lento-com-cache é a escolha certa — o caso sem cache tem os links removidos e merece pressa, o caso com cache está servindo e não é urgente. O que fica assimétrico é o alarme: o M4 deu contador escalonado ao caso **menos** grave (servindo IDs velhos) e o caso **mais** grave (links removidos) segue com aviso plano. Se voltarem a mexer nisso, um contador análogo aqui vale mais que o do M4.

## Verificação

- `npx tsc --noEmit` → exit 0.
- `git status --porcelain` → apenas `src/controllers/redirect-controller.ts` e o scratchpad da Athena. Nada fora de escopo.
- Grep confirmando consumidor único de `fetchAllValidPosts` e que `validPostsCache` só é tocado dentro dos próprios métodos de cache.
- Rounds 3-5 commitados em `8d7c3d3`; o review completo (`scratchpad/agent-hera-ecpm.md`) entrou no commit.

## Débito em aberto (inalterado desde o round 5)

M5 (invariante de referência — agora o único lugar onde a identidade é load-bearing), M6 (`!Array.isArray(items)` → `'clean'`), os nits do round 5 (texto "até ~Xh" no warn, try/catch inalcançável, `while (true)` sem teto), L1/L2 acima, BX5 (cache sem poda), BX6 (sem single-flight) e I1/M3 (ruído de eCPM de baixa amostra — decisão de produto aprovada, monitorar impressões do link nº 1 por domínio).

