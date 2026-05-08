---
agent: athena (frontend-senior-developer, cobre Node/TS)
task: aplicar fixes do code review (Hera/Aegis) na fase pos-impl
date: 2026-05-08
status: done
---

# Athena — Fix Pass (post-Hera review)

Aplicados HIGH-1, MED-1, LOW-1 da Hera. Nada do Aegis era de dominio Node/TS (todos os pontos do Aegis sao infra/Hephaestus).

## Mudancas

Unico arquivo tocado: `src/controllers/redirect-controller.ts`.

### FIX 1 (HIGH-1) — try/catch em 4 awaits Redis

| # | Funcao | Linhas (pos-edit) | Estrategia |
|---|--------|-------------------|------------|
| 1.a | `getGlobalVisitIndex` | 600-614 | catch -> console.error + return 0 |
| 1.b | `addVisitedDomain` | 615-630 | catch -> console.error (silencioso, void) |
| 1.c | `saveRules`         | 759-768 | catch -> console.error + throw err |
| 1.d | `saveInAppRules`    | 924-933 | catch -> console.error + throw err |

Trechos aplicados:

**1.a getGlobalVisitIndex**
```ts
try {
    const count = await this.redisClient.incr(key);
    if (count === 1) await this.redisClient.expire(key, 3600);
    return count - 1;
} catch (err) {
    console.error('[REDIS] getGlobalVisitIndex failed', err);
    return 0;
}
```

**1.b addVisitedDomain**
```ts
try {
    const added = await this.redisClient.sadd(key, domain);
    if (added === 1) {
        const ttl = await this.redisClient.ttl(key);
        if (ttl === -1) await this.redisClient.expire(key, 3600);
    }
} catch (err) {
    console.error('[REDIS] addVisitedDomain failed', err);
}
```

**1.c saveRules**
```ts
try {
    await this.redisClient.set(this.REDIRECT_RULES_KEY, JSON.stringify(rules));
    this.rulesCache = rules;
    this.rulesCacheTime = Date.now();
} catch (err) {
    console.error('[REDIS] saveRules failed', err);
    throw err;
}
```

**1.d saveInAppRules**
```ts
try {
    await this.redisClient.set(this.INAPP_RULES_KEY, JSON.stringify(rules));
    this.inAppRulesCache = rules;
    this.inAppRulesCacheTime = Date.now();
} catch (err) {
    console.error('[REDIS] saveInAppRules failed', err);
    throw err;
}
```

Por que `throw` em 1.c/1.d e nao em 1.a/1.b: 1.a/1.b estao no hot path do redirect — falha em Redis nao deve quebrar o redirect (degradacao graciosa). 1.c/1.d sao chamadas admin (POST/DELETE rule); o caller precisa saber se o save falhou para retornar 500 ao operador.

### FIX 2 (MED-1) — Lowercase no hostname extract

`redirect()` ~1113-1122 (fast-path antes do `new URL`):

```ts
const hostStart = redirectUrl.indexOf('//');
let hostname = '';
if (hostStart !== -1) {
    const afterScheme = redirectUrl.slice(hostStart + 2);
    const pathStart = afterScheme.indexOf('/');
    hostname = pathStart === -1 ? afterScheme : afterScheme.slice(0, pathStart);
    const qIdx = hostname.indexOf('?');
    if (qIdx !== -1) hostname = hostname.slice(0, qIdx);
    hostname = hostname.toLowerCase();   // NEW
}
const isInvertedDomain = RedirectController.INVERTED_LANG_DOMAINS.has(hostname);
```

**`redirectByGroup()` nao precisou de fix** — verifiquei a funcao linha por linha (1182-1306) e ela nao extrai hostname nem usa INVERTED_LANG_DOMAINS. A logica de idioma invertido so existe em `redirect()` (rota /main).

### FIX 3 (LOW-1) — Gating dos console.log residuais por DEBUG_REDIRECT

`redirect()`:
- L1041: `[RULE REDIRECT]` — gated
- L1070: `[INAPP REDIRECT]` — gated
- L1074: `[IFRAME]` — gated
- L1127: `[DEBUG] ranking global está VAZIO` — gated

`redirectByGroup()`:
- L1233: `[INAPP REDIRECT ${slug}]` — gated
- L1236: `[IFRAME ${slug}]` — gated
- L1284: `[DEBUG-${slug}] ranking global está VAZIO` — gated

Padrao usado:
```ts
if (RedirectController.DEBUG_REDIRECT) console.log('...');
```

`console.error` nao foi tocado (mantido sempre ativo, conforme instrucao). Logs de cron/init (linhas 149, 153, 158, 189, 215, 259, 288, 306, 312, 335, 375, 395, 421, 539) nao foram tocados — ficam sempre ativos.

## TypeScript check

```
$ npx tsc --noEmit
EXIT=0
```

Compila limpo, zero erros.

## Confirmacao de escopo

`git diff --stat`:
```
src/controllers/redirect-controller.ts | 143 +++++++++++++++++++--------------
1 file changed, 84 insertions(+), 59 deletions(-)
```

Apenas 1 arquivo tocado nesta passada. (O diff cumulativo inclui mudancas da fase de impl anterior — Athena Phase 1.)

Resumo do que foi tocado por esta sessao especificamente:
- 4 funcoes redis com try/catch (linhas ~600, ~615, ~759, ~924)
- 1 linha lowercase em `redirect()` (linha ~1124)
- 7 linhas console.log gated (4 em `redirect()`, 3 em `redirectByGroup()`)

Nada alem disso foi alterado. Sem novos arquivos, sem mudanca de assinatura, sem `npm install`.

## Proximos passos sugeridos (nao executados)

- Aegis fixes (HIGH-2 nginx perm + HIGH-3 secrets, MED-2/3) sao escopo de Hephaestus (sysadmin).
- Hera MED-2 (eviction da `validPostsCache` ilimitada) e LOW-2 (early `req.path.includes('favicon')` em redirect()) ficam como follow-up se priorizados.
