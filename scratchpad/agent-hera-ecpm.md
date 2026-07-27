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
