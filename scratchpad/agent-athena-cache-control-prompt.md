# Athena — Adicionar Cache-Control: private, no-store antes de res.redirect()

## Persona / Papel

Voce eh Athena (frontend-senior-developer). No projeto redirect, voce cobre Node/TS/Express tambem (nao ha Node engineer dedicado no Pantheon).

## Contexto do projeto

- Repo: `/Users/caionorder/Dev/redirect` (Node 20, Express, Mongo, Redis, nginx, Docker).
- Servico: redirect HTTP latency-critical. Hot path retorna 302 com Location apontando pra outro dominio.
- Obsidian PROJECTS: `redirect`. Memorias relevantes do dia 2026-05-08 ja foram lidas pelo MAIN.
- Plano: `scratchpad/PERFORMANCE_PLAN.md` (Fases 1-4). Fase 1 ja implementada e parcialmente deployada (codigo Node sim, nginx nao — divergencia conhecida).

## Tarefa

**Emitir o header `Cache-Control: private, no-store` antes de cada `res.redirect()` no controller.**

### Por que

302 sem `Cache-Control` pode ser cacheado por browsers e proxies intermediarios. Como as regras de redirect sao dinamicas (admin pode renomear/deletar slug, mudar destino, RPS-based ranking pode trocar destino entre requests), um 302 cacheado vira destino errado. `private, no-store` garante que cada request bate no servidor — eh comportamento correto pra um redirector dinamico.

### Onde aplicar

- Arquivo principal: `src/controllers/redirect-controller.ts`.
- Procurar TODAS as ocorrencias de `res.redirect(`. Pelo plan e memorias, ha varias: pelo menos no `redirect()` (~L1124+) e `redirectByGroup()`. Tambem investigar se ha outros endpoints (admin? main?) que retornem 302 — esses precisam decidir caso a caso, mas o **default eh aplicar em todos os 302 do hot path do redirector**.
- Eh **OBRIGATORIO** que o `setHeader` venha **antes** do `res.redirect()`. Express ja envia headers junto do redirect, entao a ordem importa.

### Implementacao

Forma direta:
```ts
res.setHeader('Cache-Control', 'private, no-store');
return res.redirect(<status>, targetUrl);
```

Se houver muitas ocorrencias e voce achar que vale extrair helper, **so faca o helper se reduzir 4+ linhas duplicadas**. Caso contrario, inline. Nao crie middleware novo — middleware adicionaria 1 microtask por request no hot path; o `setHeader` direto eh O(1) e zero alocacao.

### Considerar tambem

- Se houver `res.redirect()` em rotas admin (POST que volta 302 pra GET, padrao PRG), aplicar tambem — admin tambem nao deve ser cacheado (`private` ja resolve isso na maioria dos casos).
- **NAO** tocar em rotas estaticas (`/favicon`, `/robots.txt`) — essas sao 200, nao 302.
- Se a rota ja tiver `Cache-Control` setado por algum middleware (ex: helmet), o `setHeader` aqui sobrescreve — confirmar comportamento (deve sobrescrever, nao concatenar).

### Restricoes operacionais

- **Risco: LOW.** Mudanca de uma linha por callsite, no hot path.
- **NAO** rodar testes — regra global: testes so em pedido explicito.
- **NAO** commit, **NAO** push, **NAO** deploy. Apenas aplicar mudanca local.
- **SIM**, rodar `npx tsc --noEmit` no fim pra garantir que compila.
- **NAO** criar testes novos.

### Validacao final

```bash
cd /Users/caionorder/Dev/redirect
git diff --stat src/controllers/redirect-controller.ts
npx tsc --noEmit
grep -nE "res\.redirect\(" src/controllers/redirect-controller.ts | wc -l
grep -nE "Cache-Control" src/controllers/redirect-controller.ts
```

A contagem de `Cache-Control` deve ser >= numero de `res.redirect(` no hot path (cada um precedido pelo header). Se houver `res.redirect` que voce **deliberadamente** nao tocou (ex: admin que voce decidiu deixar default), liste no relatorio.

### Output local obrigatorio

`scratchpad/agent-athena-cache-control.md` — relatorio:
1. Quantos `res.redirect` existiam, em quais funcoes/linhas.
2. Quais tocou, quais deixou e por que.
3. Resultado do `tsc --noEmit`.
4. `git diff --stat` final.

### Memoria Obsidian

Apos terminar, criar memoria em:
`~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-08_HH-MM_cache-control-redirect-athena.md`

Frontmatter (date, agent, project, risk, related, tags). Conteudo: motivacao + linhas tocadas + decisao de quais nao tocar.

### Sinalizacao de fim — OBRIGATORIO

Apos salvar scratchpad e memoria, rode EXATAMENTE este comando como ULTIMO passo:

```
cmux wait-for --signal done-athena-cache-control-1778265370
```

Sem isso o orquestrador trava no timeout. O sinal eh literal — nao traduzir, nao alterar.
