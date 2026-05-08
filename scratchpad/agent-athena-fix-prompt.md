Voce e Athena, frontend-senior-developer (cobre Node/TS). Modo: APLICAR fixes do code review da Hera. Nao commit. Nao testes. Nao deploy.

## Contexto
Acabou de rodar o review da Hera em scratchpad/agent-hera-review.md e do Aegis em scratchpad/agent-aegis-review.md. Voce vai aplicar os finds que sao seu dominio (TS code).

Os impl reports anteriores estao em:
- scratchpad/agent-athena-impl.md (sua impl da Fase 1)
- scratchpad/agent-poseidon-impl.md
- scratchpad/agent-hephaestus-impl.md

## Mudancas a aplicar

### FIX 1 — HIGH-1 (Hera) — try/catch nos 4 awaits Redis
Em `src/controllers/redirect-controller.ts`, envolver cada await Redis abaixo com try/catch. Linhas aproximadas (confirme com grep antes — podem ter shift):

**1.a `getGlobalVisitIndex` (linhas ~600-609)**
- Hoje: `await this.redisClient.incr(key)` + `await this.redisClient.expire(...)`.
- Fix: try/catch ao redor. No catch: `console.error('[REDIS] getGlobalVisitIndex failed', err); return 0;`.

**1.b `addVisitedDomain` (linhas ~615-625)**
- Hoje: `await sadd` + `await ttl` + `await expire`.
- Fix: try/catch silencioso no catch: `console.error('[REDIS] addVisitedDomain failed', err);` (sem return — funcao e void).

**1.c `saveRules` (linhas ~759-764)**
- Hoje: `await this.redisClient.set('redirect:rules', JSON.stringify(rules))`.
- Fix: try/catch. No catch: `console.error('[REDIS] saveRules failed', err); throw err;` (re-throw para o caller tratar — admin operation, espera saber se falhou).

**1.d `saveInAppRules` (linhas ~924-929)**
- Idem 1.c, ajustar mensagem para `'[REDIS] saveInAppRules failed'`.

### FIX 2 — MED-1 (Hera) — Lowercase no hostname extract
Em `src/controllers/redirect-controller.ts`, na funcao `redirect()` proximo a linha 1113-1122 (fast-path antes do `new URL`):

```ts
// apos extrair hostname via substring:
hostname = hostname.toLowerCase();
if (RedirectController.INVERTED_LANG_DOMAINS.has(hostname)) {
  // ...
}
```

Verificar se ha extracao similar em `redirectByGroup()` (linhas ~1227+) e aplicar mesma normalizacao.

### FIX 3 — LOW-1 (Hera) — Gating dos console.log residuais
Em `src/controllers/redirect-controller.ts`, gatear estes 4 logs por `RedirectController.DEBUG_REDIRECT`:

- linha ~1025 `console.log('[RULE REDIRECT] ...')`
- linha ~1054 `console.log('[INAPP REDIRECT] ...')`  
- linha ~1058 `console.log('[IFRAME] ...')`
- linha ~1108 `console.log('[DEBUG] ranking global está VAZIO ...')`

Procure tambem em `redirectByGroup()` por logs equivalentes (linhas ~1216, ~1219, ~1264) — gatear todos do hot path por DEBUG_REDIRECT. Padrao:
```ts
if (RedirectController.DEBUG_REDIRECT) console.log('[RULE REDIRECT] ...');
```

NAO gatear `console.error` (manter sempre). NAO mexer em logs de cron/init (linhas 117+, 188+).

## Restricoes
- NAO commit, NAO push, NAO `npm install`
- Verificar com `Read` linhas exatas antes de editar
- `npx tsc --noEmit` deve continuar passando (rodar no fim)
- NAO mudar assinatura externa de funcao
- NAO criar arquivos novos

## Risco
LOW. Apenas envoltorios try/catch + condicional em logs.

## Entregavel
`scratchpad/agent-athena-fix.md`:
- Lista das mudancas (file:line ranges)
- Trecho do try/catch aplicado em cada call-site (1-2 linhas cada)
- Output do `npx tsc --noEmit` (deve ser EXIT=0)
- Confirmacao que nada alem dos 3 fixes acima foi tocado

## Memoria Obsidian
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-08_10-00_perf-fix-athena.md

## Passo final OBRIGATORIO
Apos aplicar tudo + tsc passar + scratchpad + obsidian, rode EXATAMENTE:
cmux wait-for --signal done-athena-fix-1730985000
