# Athena — Cache-Control: private, no-store antes de res.redirect()

## Resumo

Adicionado `res.setHeader('Cache-Control', 'private, no-store');` imediatamente antes de cada `res.redirect()` em `src/controllers/redirect-controller.ts`. Sem helper, sem middleware — inline em cada callsite (1 linha por redirect).

## Callsites mapeados

`grep -nE "res\.redirect\(" src/controllers/redirect-controller.ts` antes da mudanca retornou 6 ocorrencias, todas no hot path do redirector. Nenhuma outra controller (`grep -rnE "res\.redirect\(" src/ --include="*.ts"`) tem chamadas — escopo fechou no arquivo principal.

| # | Linha (pos) | Funcao        | Contexto                                                  | Tocado |
|---|-------------|---------------|-----------------------------------------------------------|--------|
| 1 | 1046        | `redirect()`         | match de `matchedRule` (rules dinamicas)            | sim    |
| 2 | 1076        | `redirect()`         | branch in-app (Facebook/Instagram UA)               | sim    |
| 3 | 1194        | `redirect()`         | hot path principal (`finalRedirectUrl`)             | sim    |
| 4 | 1198        | `redirect()` (catch) | fallback de erro -> `useuapp.com/random`            | sim    |
| 5 | 1242        | `redirectByGroup()`  | branch in-app (mesmo padrao do 2, por slug)         | sim    |
| 6 | 1326        | `redirectByGroup()`  | hot path principal (`finalRedirectUrl`)             | sim    |

(Numeros de linha pos-edit — antes eram 1045/1074/1191/1194/1237/1320.)

## Decisoes

- **Inline, sem helper.** 6 callsites x 1 linha = 6 linhas; criar helper economizaria nada e adicionaria uma chamada de funcao no hot path. Direto eh O(1), zero alocacao.
- **Sem middleware.** Middleware adicionaria overhead em todas as rotas (incluindo as estaticas) e mais dificil de auditar. `setHeader` direto eh explicito.
- **Catch fallback (#4) tambem recebeu.** Mesmo no path de erro o redirect sai como 302; nao queremos browsers cacheando o destino fallback `useuapp.com/random`.
- **Branch iframe (`res.send(this.generateIframeHtml(...))`) NAO tocado** — esse retorna 200 com HTML estatico de iframe, nao 302; fora do escopo. Pode ser revisitado se houver evidencia de problema, mas hoje o iframe HTML eh determinstico por destino.
- **Sem outras controllers** com `res.redirect` — nada admin pra revisar nesta task.

## Validacao

```bash
$ git diff --stat src/controllers/redirect-controller.ts
 src/controllers/redirect-controller.ts | 6 ++++++
 1 file changed, 6 insertions(+)

$ grep -cE "res\.redirect\(" src/controllers/redirect-controller.ts
6

$ grep -cE "Cache-Control" src/controllers/redirect-controller.ts
6

$ npx tsc --noEmit
# (no output — clean)
```

Cada `setHeader` esta na linha imediatamente anterior ao seu `res.redirect()` correspondente — confirmado por `grep -nE` (linhas 1045/1075/1193/1197/1241/1325 para o header; 1046/1076/1194/1198/1242/1326 para o redirect).

## Proximos passos sugeridos (NAO executados)

- Smoke test manual em staging: `curl -I` em uma rota redirect e confirmar `Cache-Control: private, no-store` no response.
- Confirmar que nginx (Fase 1 do plan, ainda nao deployada) nao adiciona/sobrescreve `Cache-Control` para essas rotas.
- Avaliar se o iframe HTML (200) precisa de header anti-cache tambem (decisao fora desta task).

## Restricoes respeitadas

- Sem testes novos.
- Sem commit, sem push.
- Apenas `tsc --noEmit` rodado (compile check, nao test).
