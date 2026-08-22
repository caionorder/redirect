# Validação independente — RPS ranking (bestRpsMode) — Argus, 2026-08-22

## Veredito
**SUFICIENTE COM RECOMENDAÇÕES** (não-bloqueantes).

## Comandos rodados (resultados reais)
- `npm run build` → `tsc` sem erros, saída limpa.
- `npm test` (antes das minhas adições) → `tsx --test $(find src -name '*.test.ts')`: 22/22 pass.
- `npm test` (depois das minhas adições) → **29/29 pass**, 0 fail, 0 skip. Duração total ~165ms.

```
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Auditoria de cobertura (antes das minhas adições)

Testes existentes de Athena (`computeRps`, `sortRpsWithEcpmFallback`) cobriam bem: uniques
undefined/0/abaixo do mínimo → null; uniques válido → cálculo correto; revenue 0 válido (não
null); RPS válido antes de null; ordenação por rps desc; desempate ecpm desc → revenue desc (nos
dois buckets); todos-null == ordem eCPM pura; array vazio; não-mutação do input.

Lacunas identificadas (item 2 da tarefa):
1. **Boundary uniques=10 exato** — testado implicitamente (linha 14 do arquivo original,
   `computeRps(100,10,10)=10`), mas não lado a lado com o caso 9 no mesmo teste para deixar o
   boundary explícito.
2. **uniques negativo** (dado sujo, ex. parse malformado) — não testado.
3. **revenue negativo** com uniques válido — não testado (comportamento: RPS negativo, tratado
   como "válido", não cai no fallback).
4. **NaN em revenue/uniques** (dado sujo upstream) — não testado. Ver finding abaixo.
5. **Item com `rps` NaN dentro de `sortRpsWithEcpmFallback`** — não testado; risco de exceção ou
   de item descartado.
6. **Lista com 1 item** — não testada explicitamente.
7. **Estabilidade em empate total** (rps, ecpm, revenue todos iguais) — não testada; relevante
   porque `interleaveByDomain` no controller depende da ordem determinística de `ranking` para
   escolher a primeira ocorrência de cada domínio.

Testes que ADICIONEI (7 novos, todos em `src/utils/rps-ranking.test.ts`, todos passando):
- `computeRps: uniques negativo (dado sujo) é tratado como abaixo do mínimo → null`
- `computeRps: uniques exatamente no mínimo (10) é válido; 9 continua null (boundary)`
- `computeRps: revenue negativo com uniques válido produz RPS negativo (não é tratado como inválido)`
- `computeRps: revenue NaN com uniques válido propaga NaN (não retorna null) — comportamento atual, não guardado`
- `sortRpsWithEcpmFallback: item com rps NaN não lança exceção e não descarta nenhum item da lista`
- `sortRpsWithEcpmFallback: lista com 1 item retorna o mesmo item`
- `sortRpsWithEcpmFallback: estabilidade — empate total (rps, ecpm, revenue iguais) preserva a ordem original de entrada`

Nenhum código de produção foi alterado (confirmado via `git status`/`git diff --stat`: apenas
`src/utils/rps-ranking.test.ts`, que já era untracked/de Athena, recebeu as adições).

## Finding — `computeRps` não guarda contra NaN (severidade: baixa, não-bloqueante)

`computeRps(revenue, uniques, minUniques)` só valida `uniques` (`undefined` ou `< minUniques`).
Se `revenue` chegar como `NaN` (dado sujo vindo do ranking eCPM/banco, sem relação com
`PageviewService`), a função retorna `NaN` em vez de `null` — ou seja, é tratado como "RPS
válido" e entra no bucket `withRps` de `sortRpsWithEcpmFallback`. Como comparações com `NaN`
(`b.rps! - a.rps!`) sempre avaliam para `NaN`, que o V8 trata como "não trocar" no comparator, o
item não é descartado nem lança exceção — mas sua posição final fica arbitrária/dependente da
ordem de entrada, potencialmente aparecendo bem-posicionado no ranking com um RPS inválido.

Caminho real de `uniques`: `PageviewService.fetchUniqueVisitors` já filtra com
`typeof visitas === 'number' && Number.isFinite(visitas)` antes de popular o map consumido pelo
controller — então `NaN` não entra por `uniques` na prática atual. Mas `revenue` (que vem do
ranking eCPM já existente, não passa pelo `PageviewService`) não tem nenhum guard equivalente
antes de chegar em `computeRps`.

**Recomendação (não implementada — fora do meu escopo, reportando para o implementador/reviewer
decidirem):** adicionar `!Number.isFinite(revenue)` ao guard de `computeRps`, retornando `null`
nesse caso, para que dado sujo em `revenue` sempre caia no fallback eCPM em vez de produzir um
RPS `NaN` "válido". Baixo risco de regressão (revenue vindo do ranking normal já é sempre um
número finito na prática hoje), mas fecha a lacuna de robustez para dado futuro sujo.

## Item 4 da tarefa — parse defensivo de `fetchUniqueVisitors`/`fetchBulkUniques`

**Já está adequado, nenhum finding.** `fetchUniqueVisitors` (pageview-service.ts):
- `!response.ok` → `null`.
- `json.status !== 'success' || !Array.isArray(json.data)` → `null` (cobre `data` ausente,
  `data` não-array, `status` de erro).
- `data` vazio → `json.data[0]` é `undefined` → `?.visitas` é `undefined` → falha o
  `typeof visitas !== 'number'` → `null` (não lança exceção).
- `visitas` como string ou qualquer tipo não-number → `null` via `typeof` check.
- `visitas` como `NaN`/`Infinity` → `null` via `Number.isFinite`.
- Todo o corpo está em `try/catch`, então erro de rede/timeout/JSON malformado (`response.json()`
  lançando) também cai em `null` via `catch`.

`fetchBulkUniques` usa `Promise.allSettled` e só popula o map quando
`result.status === 'fulfilled' && result.value !== null` — uma rejeição isolada (não deveria
acontecer dado o try/catch interno, mas é defesa em profundidade) não derruba o lote nem lança.

**Recomendação (não implementada, baixa prioridade):** a lógica de parse (linhas ~145-155 de
`pageview-service.ts`, do `json.status !== 'success'` até o `return visitas`) está inline dentro
do método com I/O real, então não dá para testá-la isoladamente sem mock de `fetch`/`nock`. Se o
time quiser cobertura unitária determinística desse parse (sem depender de mock de rede),
extrair um `parseUniquesResponse(json: unknown): number | null` puro seria trivial e testável
como as funções de `rps-ranking.ts` — mas isso é refatoração de produção, fora do meu escopo
(reportando, não implementando).

## Resumo para o orquestrador

- Suíte 29/29 pass, build limpo — evidência real, confirmada de forma independente.
- Cobertura das funções puras estava boa; adicionei 7 testes de borda (boundary, negativos, NaN,
  estabilidade, lista de 1 item) — todos passando, nenhum revelou falha nova além do finding de
  NaN já documentado (que é comportamento, não crash).
- 1 finding de baixa severidade em `computeRps` (NaN em `revenue` não é guardado) — recomendação
  registrada, não corrigida (fora do meu escopo como test engineer).
- `fetchUniqueVisitors`/`fetchBulkUniques` já têm parse defensivo adequado — sem exceção não
  tratada em nenhum cenário de payload malformado testado por leitura de código.
- Nenhum código de produção alterado por mim.
