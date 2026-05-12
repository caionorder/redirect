Você é Athena (Frontend Senior Developer). Trabalhe em /Users/caionorder/Dev/redirect.

# Contexto do projeto

Serviço Node.js/TypeScript de redirecionamento (Express + Mongo + Redis) que propaga UTMs para destinos finais. Hot path em src/controllers/redirect-controller.ts. Você já tocou neste projeto antes (cache-control, routing-fix, perf-impl — ver memórias Obsidian em ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/).

# Findings (do Odysseus — investigação prévia)

Relatório completo em scratchpad/agent-odysseus.md. Resumo:

O utm_term é preservado corretamente no path principal (L1166-1183 e L1298-1315), MAS é perdido nos 3 branches de Rule/InApp Rule porque:

1. Usam `if (value)` (truthy check) em vez de `if (value !== undefined && value !== null)` — derruba string vazia.
2. Usam `searchParams.append(...)` em vez de `.set(...)` — se a destination já tem `utm_term=...` hardcoded, cria duplicata e parsers que pegam o PRIMEIRO valor (Java Servlet, alguns frameworks) retornam o hardcoded.
3. `passQueryParams: false` (config no Redis) hoje descarta TUDO.

Branches afetados:
- `src/controllers/redirect-controller.ts:1037-1048` — Rule branch
- `src/controllers/redirect-controller.ts:1057-1083` — InApp branch em redirect()
- `src/controllers/redirect-controller.ts:1224-1248` — InApp branch em redirectByGroup()

# Task — FIX

Risco: **MÉDIO** (hot path de redirect em produção). Aplicar o fix MÍNIMO:

## 1. Criar helper privado na classe RedirectController

```ts
private forwardQueryParams(targetUrl: URL, query: Record<string, any>): void {
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        const v = Array.isArray(value) ? value[value.length - 1] : value;
        targetUrl.searchParams.set(key, String(v));
    }
}
```

Coloque o helper junto dos outros métodos privados utilitários da classe (procure por `private` no arquivo e ache lugar coerente — provavelmente perto de `generateIframeHtml` ou similar). Mantenha o estilo do código existente (acessores, types, indentação).

## 2. Substituir os 3 trechos `for…of` por chamada ao helper

Branch 1 — Rule (L1037-1048):
```ts
- if (matchedRule.passQueryParams) {
-     for (const [key, value] of Object.entries(req.query)) {
-         if (value) ruleUrl.searchParams.append(key, String(value));
-     }
- }
+ if (matchedRule.passQueryParams) {
+     this.forwardQueryParams(ruleUrl, req.query as Record<string, any>);
+ }
```

Branch 2 — InApp em redirect() (L1057-1083): mesma substituição. Atenção: depois do for…of, tem o `if (req.params.campaignId) inAppUrl.searchParams.append('utm_campaign', ...)`. **Manter esse append como está** — é semântica diferente (parametro de path vira utm_campaign). NÃO trocar por set aqui pra não quebrar comportamento de hoje. Apenas substituir o loop genérico.

Branch 3 — InApp em redirectByGroup() (L1224-1248): mesmo padrão do Branch 2.

## 3. NÃO altere

- O hot path principal (L1166-1183 e L1298-1315) — já está correto.
- A semântica de `passQueryParams: false` (não tem que virar whitelist agora — fora de escopo, é decisão de produto).
- A lógica de iframe.
- Nada além dos 3 trechos.
- Não adicione testes (regra global: testes só quando explicitamente pedido).

## 4. Validação

- Após editar, rode `npx tsc --noEmit` (ou o script de typecheck do package.json — confira o `scripts` antes) pra garantir que não quebrou tipos.
- Rode também o `lint` se houver script (`npm run lint`), só pra confirmar.
- NÃO rode o servidor. NÃO faça commit.

# Entregáveis obrigatórios

1. Aplicar as 3 substituições + helper.
2. Confirmar build (`tsc --noEmit`) limpo.
3. Salvar em `scratchpad/agent-athena.md`:

```
# Fix utm_term — Athena

## Mudanças aplicadas
- src/controllers/redirect-controller.ts:LL — adicionado helper forwardQueryParams
- src/controllers/redirect-controller.ts:LL — Rule branch substituído
- src/controllers/redirect-controller.ts:LL — InApp branch (redirect) substituído
- src/controllers/redirect-controller.ts:LL — InApp branch (redirectByGroup) substituído

## Diff resumo
<3 hunks com 5 linhas de contexto cada>

## Typecheck
<output de tsc --noEmit, idealmente "0 errors">

## Notas
<qualquer surpresa, desvio ou decisão tomada>

## Próximos passos sugeridos
- Code review por Hera antes de merge
- Verificar regras no Redis (`passQueryParams`, `destination` com utm hardcoded)
- Setar `DEBUG_REDIRECT=1` em staging pra confirmar branches batendo
```

4. Criar memória Obsidian em `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-12_HH-MM_fix-utm-term-rule-branches-athena.md` com YAML frontmatter (date, project: redirect, agent: athena, type: implementation, tags) + corpo descrevendo o fix.

# Passo final OBRIGATÓRIO

Depois de salvar scratchpad/agent-athena.md E a memória Obsidian, rode EXATAMENTE este comando (literal):

cmux wait-for --signal done-athena-utmterm-fix-1747000000
