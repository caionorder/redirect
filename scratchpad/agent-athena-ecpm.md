# Athena — Ranking por eCPM (2026-07-27)

## Resumo
Trocado o critério de ordenação do ranking de `redirect-controller.ts` de RPS (revenue/unique visitors, dependente da API externa pageview.joinads.me) para eCPM direto com corte mínimo de 100 impressões. Motivo: a API de pageviews só tinha dados para 1 de 19 domínios do grupo main, jogando 47/50 slots do ranking para `/random`.

## Arquivo tocado
- `src/controllers/redirect-controller.ts` (único arquivo de código alterado)
- `backups/redirect-controller.ts.2026-07-27.bak` (novo — cópia do original antes das mudanças)

## Mudanças aplicadas
1. `impressions < 50` → `impressions < 100` (linha ~224).
2. Removido bloco `this.pageviewService.fetchBulkPageviews(...)` + loop que preenchia `uniqueVisitors`/`rps`.
3. Removido filtro `uniqueVisitors >= 10`; `filteredRanking` agora é o próprio `limitedRanking` ordenado por `ecpm` desc.
4. Ordenação final: `sort((a,b) => b.rps - a.rps)` → `sort((a,b) => b.ecpm - a.ecpm)`.
5. Campos `uniqueVisitors: 0` e `rps: 0` mantidos na interface `LinkInfo` e no item criado (compatibilidade com JSON já salvo no Redis e com `/api/rank`).
6. `interleaveByDomain`: sort de domínios por `rps` → `ecpm`; comentário atualizado.
7. Log do top 5: removido RPS/uniques do log, mostra `eCPM` e `revenue`.
8. Logs de "<50 impressões" → "<100 impressões"; log de "Nenhum post com RPS válido" → "Nenhum post com eCPM válido".
9. Removida a property `pageviewService`, a inicialização no constructor, e o import de `PageviewService`. Arquivo `src/services/pageview-service.ts` mantido intacto (não usado, fica como referência).

## Não alterado (conforme escopo)
- `getBestRpsLink` — itera o ranking na ordem salva; passa a servir automaticamente "melhor eCPM não visitado" sem mudança de código. Nomes internos (`bestrps_*`, `BEST_RPS`) mantidos como estão.
- `validateRanking`, round-robin, slice(50), Redis, fluxo de serving — intocados.
- Corte "top 10 por domínio ordenado por revenue" (linhas ~247-257 originais) — mantido exatamente como estava.

## Comandos rodados + resultados reais
```
mkdir -p backups && cp src/controllers/redirect-controller.ts backups/redirect-controller.ts.2026-07-27.bak
→ OK, arquivo de 63767 bytes copiado.

grep -n pageviewService src -r
→ sem match no controller (só a classe original em src/services/pageview-service.ts).

npm run build
→ 1ª tentativa: falhou com erros PRÉ-EXISTENTES e não relacionados:
   src/routes/docs-route.ts(4,23): error TS2307: Cannot find module 'js-yaml'
   src/routes/docs-route.ts(5,23): error TS2307: Cannot find module 'swagger-ui-express'
→ Confirmado pré-existente: git stash + npm run build na main sem minhas mudanças reproduziu os MESMOS 2 erros.
→ Causa: node_modules incompleto (js-yaml e swagger-ui-express já estavam no package.json mas não instalados).
→ Rodei `npm install` (sem alterar package.json) para popular node_modules. Isso gerou 1 linha de diff em package-lock.json (removeu "peer": true de express) — revertido com `git checkout -- package-lock.json` por estar fora de escopo.
→ 2ª tentativa (com node_modules populado): `npm run build` passou SEM erros.

git status --short (final)
→ M src/controllers/redirect-controller.ts   (único arquivo rastreado alterado)

git diff --stat (final)
→ src/controllers/redirect-controller.ts | 41 +++++++++-------------------------
→ 1 file changed, 10 insertions(+), 31 deletions(-)
```

## Riscos
- Domínios cujos posts nunca chegam a 100 impressões/dia deixam de entrar no ranking (antes o corte era 50). Efeito esperado do pedido do usuário, mas monitorar se algum domínio pequeno some do rank.
- `uniqueVisitors` e `rps` ficam sempre 0 nos novos itens gravados no Redis; consumidores que dependiam desses campos (ex: dashboards externos, se existirem) passam a ver sempre 0. `/api/rank` e `/api/rank-by-domain` já usam `ecpm`/`clickCount`, não foram afetados.
- `node_modules` precisou ser populado via `npm install` para o build passar neste ambiente local — isso não é uma mudança de código, é um pré-requisito de ambiente que já estava quebrado antes desta tarefa (não introduzido por mim).

## Round 2 — fixes do review (Hera)

Review completo em `scratchpad/agent-hera-ecpm.md`: **APROVADO COM RESSALVAS**, sem blocker. Apliquei os 6 findings pedidos (I1, I2, I3, B1, B2, B4). NÃO apliquei M1, M2, M3, B3 — decisão de produto pendente, conforme instruído pelo team-lead.

### Mudanças aplicadas

**I1 — Desempate explícito no sort por eCPM** (`redirect-controller.ts`, bloco de ordenação em `executeProcessForGroup`): comparador trocado de `(a,b) => b.ecpm - a.ecpm` para `(a,b) => (b.ecpm - a.ecpm) || (b.revenue - a.revenue)`. Comentário explica que o eCPM vem arredondado a 2 casas e empates são frequentes.

**I2 — Comentários falsos em `getBestRpsLink`**: docstring reescrita para descrever o comportamento real (lista intercalada por domínio via round-robin, não ordenada globalmente; ronda 0 = melhor eCPM de cada domínio). Comentário inline "Iterate ranking (already sorted by RPS descending)" também reescrito. `bestrps_*`, `BEST_RPS` e o nome da função `getBestRpsLink` NÃO foram renomeados — adicionei nota explícita no docstring dizendo que esses nomes são chave de atribuição de cliques em `redirects_clicks` e estão congelados.

**I3 — OpenAPI desatualizado** (`docs/openapi.yaml`): atualizadas as descrições que afirmavam "calcula RPS via pageviews" (linhas ~8, 57, 374, 529, 534) para refletir eCPM + corte de >=100 impressões; removida a menção a "pageviews API" no aviso de custo do `/api/process` (API não é mais chamada). Schema `RankedLink`: `rps` e `uniqueVisitors` marcados `deprecated: true` com descrição "Sempre 0. Campo mantido por compatibilidade de payload...". **Shape do schema não mudou** — `required: [url, domain, postId, ecpm, revenue, uniqueVisitors, rps]` intacto, verificado via parse (`js-yaml`) após a edição.

**B1 — Alias puro removido**: `const filteredRanking = limitedRanking;` eliminado; o sort e o `validateRanking(...)` agora operam direto em `limitedRanking`.

**B2 — Guard contra NaN no eCPM**: `parseFloat(String(item.ecpm || 0))` agora passa por `Number.isFinite(...)` antes de virar a chave do sort; se vier NaN, cai para 0.

**B4 — Docstring de `executeProcessForGroup`**: adicionada linha dizendo que `uniqueVisitors`/`rps` são sempre 0, mantidos só por compatibilidade.

### Comandos rodados + resultados reais
```
npm run build
→ passou sem erros (segunda vez consecutiva; node_modules já populado desde a Round 1).

node -e "yaml.load(fs.readFileSync('docs/openapi.yaml'))..."
→ YAML OK. RankedLink required: ["url","domain","postId","ecpm","revenue","uniqueVisitors","rps"]
→ rps deprecated: true / uniqueVisitors deprecated: true

grep -n "pageviewService\|filteredRanking" src -r
→ sem matches (exit 1).

git status --short (final)
→  M docs/openapi.yaml
→  M src/controllers/redirect-controller.ts
→  ?? scratchpad/agent-athena-ecpm.md
→  ?? scratchpad/agent-hera-ecpm.md

git diff --stat (final, cumulativo Round 1 + Round 2 vs HEAD)
→ docs/openapi.yaml                      | 22 +++++++------
→ src/controllers/redirect-controller.ts | 57 +++++++++++++---------------------
→ 2 files changed, 35 insertions(+), 44 deletions(-)
```

### Riscos (Round 2)
- Nenhum risco novo introduzido pelos 6 fixes — são correções de robustez (tie-break, NaN guard) e documentação (comentários, OpenAPI).
- M1/M2/M3/B3 permanecem como débito técnico documentado no review da Hera, aguardando decisão de produto do Caio; não bloqueiam o deploy desta mudança.

## Round 3 — M1 + M2 (aprovados pelo Caio)

Base: tudo commitado em `9f2a8e4` antes de iniciar (working tree limpo, confirmado via `git status --short` e `git log --oneline -3`). Diff desta rodada é só sobre `src/controllers/redirect-controller.ts`.

### Mudança 1 — Corte por domínio agora é por eCPM (M1)
- `globalRanking.sort(...)`: `(a,b) => b.revenue - a.revenue` → `(a,b) => (b.ecpm - a.ecpm) || (b.revenue - a.revenue)` — mesmo comparador do sort final, aplicado ANTES do corte de top-10 por domínio.
- Comentário do corte: "Limitar a 10 itens por domínio (top 10 por receita de cada domínio)" → "... (top 10 por eCPM de cada domínio, desempate por revenue)".
- Sort final de `limitedRanking` mantido (mesmo comparador) — vira reafirmação explícita do invariante, comentário atualizado para "Reafirma o mesmo critério do corte acima — mantém o invariante explícito e barato."
- Efeito: o post de maior eCPM de um domínio agora sempre entra no top-10 daquele domínio (antes podia ficar de fora se não estivesse entre os 10 de maior revenue).

### Mudança 2 — Cache de validação WP: TTL 60min + merge (M2)
- `VALID_POSTS_CACHE_TTL_MS`: `900000` (15min) → `3600000` (60min); comentário: "cobre ~4 ciclos do cron de 15 min".
- Extraí a lógica de fetch+fallback (antes inline em `fetchAllValidPosts`) para um novo método privado `fetchDomainsFromApi(domains, fallbackCache)` — necessário para reutilizar a mesma lógica nas duas ramificações (cache fresco parcial / cache expirado) sem duplicar código. Não é refactor fora de escopo: é a estrutura mínima para implementar o merge pedido.
- `fetchAllValidPosts` reescrito:
  - Cache fresco (dentro do TTL) e todos os domínios pedidos já cacheados → retorna `this.validPostsCache` direto (igual ao comportamento anterior).
  - Cache fresco mas com domínios faltantes → busca via API SÓ os faltantes (`fetchDomainsFromApi(missingDomains, this.validPostsCache)`), mescla no `this.validPostsCache` (`.set` por domínio, sem substituir o mapa inteiro), retorna um Map cobrindo todos os `domainsToCheck` (lidos do cache já mesclado). `validPostsCacheTime` NÃO é atualizado nesse ramo (timestamp continua global, conforme instruído).
  - Cache expirado (ou vazio) → busca todos os `domainsToCheck` via `fetchDomainsFromApi`, mescla no `this.validPostsCache` e atualiza `validPostsCacheTime = now`.
  - Em ambos os casos o cache global NUNCA é substituído inteiro — entradas de domínios de outros grupos (ex: `db` enquanto se processa `main`) são preservadas.
- JSDoc de `fetchAllValidPosts` e do novo `fetchDomainsFromApi` atualizados descrevendo o comportamento atual.
- Semântica de consumo em `validateRanking` não mudou: ainda faz `validPostsMap.get(link.domain)` e remove o link se o domínio não estiver no mapa — verificado que o Map retornado por `fetchAllValidPosts` sempre cobre todos os domínios pedidos (cada domínio recebe algum resultado, mesmo que falho).

### Comandos rodados + resultados reais
```
git status --short / git log --oneline -3 (antes de editar)
→ working tree limpo, HEAD em 9f2a8e4 "feat(ranking): trocar critério de RPS para eCPM com piso de 100 impressões"

npm run build
→ passou sem erros.

grep -n "previousCache\|allCached" src/controllers/redirect-controller.ts
→ sem matches (exit 1) — confirma que a lógica antiga de cache foi totalmente substituída, não deixou código morto.

git status --short (final)
→  M src/controllers/redirect-controller.ts   (único arquivo alterado)

git diff --stat (final, só Round 3)
→ src/controllers/redirect-controller.ts | 89 ++++++++++++++++++++++------------
→ 1 file changed, 59 insertions(+), 30 deletions(-)
```

### Riscos (Round 3)
- M1: nenhum risco novo — é uma correção de coerência (corte e ranking final usam o mesmo critério agora). Pode mudar quais posts aparecem no ranking em produção (esperado, é o objetivo do fix).
- M2: TTL maior (60min) significa que se um post for editado/removido no WordPress, o link pode continuar sendo servido por até 1h a mais do que antes (15min) até a próxima varredura invalidar. Trade-off aceito pelo Caio para reduzir o fan-out de requests contra os 19 WordPress de produção a cada ciclo de cron.
- M3 e B3 continuam não aplicados (fora do escopo desta rodada, sem pedido do usuário).

## Round 4 — fix BL1 (blocker da Hera) + BX1/BX2/BX7

Hera bloqueou o Round 3: `scratchpad/agent-hera-ecpm.md`, seção "Round 3 — M1 + M2 aplicados", veredito **BLOQUEADO**.

### BL1 (blocker, corrigido) — timestamp por domínio no cache de validação WP
Defeito: `validPostsCacheTime` era global. Com o merge do Round 3, o primeiro grupo processado no cron (`main`, 14 domínios) resetava o relógio global sempre que revalidava; todo grupo seguinte na mesma passada (`db`, 5 domínios, disjunto de `main`) caía no early return "cache fresco, sem faltantes" e nunca mais revalidava seus próprios domínios — as entradas de `db` congelavam no valor buscado no boot e envelheciam indefinidamente (processo long-lived, só reinicia em deploy).

Fix aplicado (recomendação da Hera): cache reestruturado para `Map<string, ValidPostsCacheEntry>` onde `ValidPostsCacheEntry = { result: FetchPostIdsResult; fetchedAt: number }` — timestamp por entrada, não mais um `validPostsCacheTime` global (removido por completo). `missingDomains` agora é "domínio ausente do cache OU sua entrada expirou (`now - entry.fetchedAt >= TTL`)". Cada domínio expira no seu próprio horário, independente de quando outros domínios (do mesmo grupo ou de outro grupo) foram buscados. `fetchedAt` é atualizado para `now` tanto em sucesso quanto no fallback-por-falha (a entrada reaproveitada continua sendo a boa, mas o relógio registra que uma tentativa de refetch aconteceu agora — evita hammering do WP a cada ciclo de cron enquanto o domínio está fora do ar).

**Simulação mental pedida pelo team-lead** (main 14 domínios, db 5 domínios disjuntos, cron a cada 15min, TTL 60min, ambos processados em t=0):
```
t=0    main: 14 domínios sem entrada  → fetch, fetchedAt=0
t=0    db:    5 domínios sem entrada  → fetch, fetchedAt=0
t=15/30/45  main: entry.fetchedAt=0, idade<60min → cache (sem fetch)
t=15/30/45  db:   entry.fetchedAt=0, idade<60min → cache (sem fetch)
t=60   main: idade=60min >= TTL → fetch, fetchedAt=60
t=60   db:   idade=60min >= TTL → fetch, fetchedAt=60      ← CONFIRMADO: db revalida em t=60,
                                                               independente do timestamp de main
t=75/90/105 (ambos): idade<60min desde t=60 → cache
```
`db` revalida em t=60 porque seu próprio `fetchedAt` (setado em t=0) é o que conta, não o de `main`. O bug do Round 3 (timestamp global sendo resetado só por `main`) deixa de existir — não há mais timestamp compartilhado.

### BX1 (aplicado) — sempre retornar Map novo
`fetchAllValidPosts` agora SEMPRE constrói e retorna um `Map` novo (não a referência viva de `this.validPostsCache`) nos dois ramos (com ou sem domínios faltantes) — elimina o aliasing inconsistente que o Round 3 tinha no caminho "tudo cacheado".

### BX2 (aplicado) — comentário do sort de `limitedRanking`
Comentário trocado para "O interleave exige ordem eCPM-desc; este sort garante isso independentemente do critério usado no corte acima." — decisão da Hera de manter o sort (não é mais tratado como no-op "reafirmação", e sim como proteção contra mudança futura no comparador do corte de `globalRanking`).

### BX7 (aplicado) — log correto do cache-hit
O log do ramo "sem domínios faltantes" agora reporta `domainsToCheck.length` (domínios deste request) em vez de `this.validPostsCache.size` (que sob merge é o total de todos os grupos, número que enganava a leitura).

### NÃO aplicado (fora de escopo desta rodada, por instrução do team-lead)
BX5 (poda de domínios órfãos do cache), BX6 (single-flight para `/api/process` concorrente), I1/M3 (piso de impressões — decisão do usuário: manter 100 e monitorar).

### Comandos rodados + resultados reais
```
grep -n "validPostsCache\|validPostsCacheTime" src/controllers/redirect-controller.ts
→ só ocorrências do novo `validPostsCache: Map<string, ValidPostsCacheEntry>`; zero `validPostsCacheTime` restante.

npm run build
→ passou sem erros.

git status --short (final)
→  M scratchpad/agent-athena-ecpm.md
→  M scratchpad/agent-hera-ecpm.md   (não tocado por mim nesta sessão — já vinha modificado pela Hera antes deste round)
→  M src/controllers/redirect-controller.ts

git diff --stat -- src/controllers/redirect-controller.ts (Round 4 isolada)
→ src/controllers/redirect-controller.ts | 99 ++++++++++++++++++++++------------
→ 1 file changed, ~65 insertions(+), ~34 deletions(-) (cumulativo desde HEAD 9f2a8e4, incluindo Round 3)
```

### Riscos (Round 4)
- Nenhum risco novo — é uma correção de corretude (o bug do Round 3 era uma regressão silenciosa que só se manifestaria após 1h+ de uptime). Comportamento agora é estritamente melhor: cada domínio revalida no seu próprio prazo, sem depender da ordem de iteração dos grupos no cron.
- I1 (levantado pela Hera no Round 3: M1 tornou o pool de candidatos de cada domínio mais suscetível a eCPM de baixa amostra) segue como recomendação de monitoramento pós-deploy, não bloqueante — decisão do usuário foi manter o piso de 100 impressões e observar o top-5 de cada domínio nos primeiros ciclos.

## Round 5 — I2 (paginação truncada) + M4 (alarme de fallback persistente)

Hera aprovou o Round 4 com ressalvas (`scratchpad/agent-hera-ecpm.md`, seção "Round 4 — fix do BL1 + nits", veredito **APROVADO COM RESSALVAS**). O Caio aprovou aplicar I2 e M4 desta rodada.

### I2 (aplicado) — paginação truncada não vira mais sucesso
Problema: `fetchIdsFromEndpoint` marcava sucesso assim que a PRIMEIRA página respondia OK, mesmo que uma página seguinte falhasse (429/5xx) — um conjunto parcial de IDs virava autoritativo e `validateRanking` removia posts antigos válidos que não estavam nesse conjunto truncado (a query usa `orderby=date&order=desc`, então o conjunto truncado é sempre dos posts mais novos — os que faturam ficam de fora). Com o TTL do M2 em 60min, um rate-limit passageiro ficava "grudado" por 4x mais tempo que antes.

Fix: `fetchIdsFromEndpoint` passa a retornar um tri-state `EndpointFetchStatus = 'clean' | 'failed' | 'truncated'`:
- `'clean'`: paginação terminou naturalmente (lista vazia, última página parcial) OU HTTP 400 em página > 1 (o WordPress usa esse código para "página além do total" — fim de catálogo, não erro).
- `'failed'`: a primeira página nunca respondeu (endpoint ausente/indisponível) — inclui exceção de rede/timeout na primeira página.
- `'truncated'`: paginação começou mas foi interrompida por resposta não-OK diferente de 400 em página > 1, ou por exceção de rede/timeout depois da primeira página.
- Movi o try/catch para DENTRO de `fetchIdsFromEndpoint` (antes vivia em `fetchValidPostIds` com `.catch(() => false)`, que perdia a informação de quantas páginas já tinham sido lidas) — necessário para diferenciar 'failed' de 'truncated' em erro de rede.

Em `fetchValidPostIds`, a regra de sucesso do domínio mudou de `postsOk || pagesOk` para `(pelo menos um endpoint 'clean') && (nenhum endpoint 'truncated')`. Log atualizado para mostrar o estado de cada endpoint (`clean`/`failed`/`truncated`) em vez de `ok`/`falhou`.

**3 cenários confirmados por leitura do código (pedido do team-lead):**
- (a) 429 na página 2 de `/posts`, `/pages` clean → `postsStatus='truncated'`, `pagesStatus='clean'` → `hasCleanEndpoint=true`, `hasTruncatedEndpoint=true` → `success = true && !true = false` → domínio marcado como falho → cai no fallback existente.
- (b) `/pages` 404 na página 1, `/posts` clean → `pagesStatus='failed'`, `postsStatus='clean'` → `hasCleanEndpoint=true`, `hasTruncatedEndpoint=false` → `success=true` — comportamento atual preservado (endpoint ausente desde o início continua tolerado).
- (c) catálogo com exatamente 100 posts → página 1 retorna 100 itens (`items.length === perPage`, não `<`), continua para página 2 → página 2 retorna HTTP 400 → `page===1`? não; `status===400`? sim → `'clean'`.

### M4 (aplicado) — alarme para fallback persistente
Adicionado `consecutiveFallbacks: number` a `ValidPostsCacheEntry`. Em `fetchAllValidPosts`, ao gravar uma entrada vinda de `fetchDomainsFromApi`: se o objeto `fetchResult` for a MESMA referência do `.result` da entrada anterior no cache (indica que foi reaproveitado via fallback, não um fetch novo bem-sucedido — `fetchDomainsFromApi` faz literalmente `result.set(domain, cached)` nesse caso), incrementa `consecutiveFallbacks` a partir da entrada anterior; caso contrário (fetch novo, sucesso ou falha genuína sem fallback disponível) zera para 0. A partir de `consecutiveFallbacks >= 2`, emite `console.warn` com domínio, contagem, e horas estimadas de defasagem (`consecutiveFallbacks × TTL em horas`). O comportamento de backoff (`fetchedAt = now` mesmo no fallback) foi mantido como estava — decisão já validada pela Hera no Round 4.

### Não aplicado (fora de escopo, conforme instruído)
Demais nits do Round 4 review (BX5, BX6) e I1/M3 do Round 3 — decisões de produto/débito técnico documentado, sem pedido do usuário para esta rodada.

### Comandos rodados + resultados reais
```
npm run build
→ passou sem erros.

grep -n "atLeastOneSuccess|postsOk|pagesOk" src/controllers/redirect-controller.ts
→ sem matches (exit 1) — confirma que a lógica booleana antiga foi totalmente substituída pelo tri-state.

git status --short (final)
→  M scratchpad/agent-athena-ecpm.md
→  M scratchpad/agent-hera-ecpm.md   (não tocado por mim — Hera adiciona suas próprias seções)
→  M src/controllers/redirect-controller.ts

git diff --stat -- src/controllers/redirect-controller.ts (cumulativo desde HEAD 9f2a8e4, Rounds 3+4+5 ainda não commitados)
→ src/controllers/redirect-controller.ts | 210 +++++++++++++++++++++++----------
→ 1 file changed, 146 insertions(+), 64 deletions(-)
```

### Riscos (Round 5)
- Nenhum risco novo introduzido — I2 é estritamente mais conservador (domínios que antes eram marcados como sucesso com dados parciais agora corretamente caem no fallback/falha). Efeito esperado: menos "sumiço" de posts antigos válidos quando um domínio sofre rate-limit no meio da paginação.
- M4 é só observabilidade (console.warn) — não muda comportamento de roteamento/serving.
- Débito técnico documentado pela Hera que segue em aberto: BX5 (poda de cache órfão), BX6 (single-flight para `/api/process` concorrente com o cron).
