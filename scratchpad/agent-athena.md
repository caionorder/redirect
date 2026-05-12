# Fix utm_term — Athena

## Mudanças aplicadas

- `src/controllers/redirect-controller.ts:910-921` — adicionado helper `forwardQueryParams` (colocado entre `generateIframeHtml` e `getInAppRules`, junto dos utilitários privados).
- `src/controllers/redirect-controller.ts:1050-1053` — Rule branch substituído (loop `for…of` com `append` → chamada ao helper).
- `src/controllers/redirect-controller.ts:1068-1075` — InApp branch dentro de `redirect()` substituído. O `append('utm_campaign', req.params.campaignId)` foi **preservado** como instruído.
- `src/controllers/redirect-controller.ts:1234-1241` — InApp branch dentro de `redirectByGroup()` substituído. Mesmo padrão do anterior; `append` de `utm_campaign` via path preservado.

## Diff resumo

```diff
@@ src/controllers/redirect-controller.ts  (helper)
     <iframe src="${url}" allowfullscreen></iframe>
 </body>
 </html>`;
     }

+    /**
+     * Repassa query params para uma URL de destino preservando string vazia e
+     * sobrescrevendo (set) ao invés de duplicar (append) para evitar colisão
+     * com params hardcoded no destination.
+     */
+    private forwardQueryParams(targetUrl: URL, query: Record<string, any>): void {
+        for (const [key, value] of Object.entries(query)) {
+            if (value === undefined || value === null) continue;
+            const v = Array.isArray(value) ? value[value.length - 1] : value;
+            targetUrl.searchParams.set(key, String(v));
+        }
+    }
+
     /**
      * Obtem as regras de in-app do cache (com cache em memória)
      */
     private async getInAppRules(): Promise<InAppRule[]> {
```

```diff
@@ src/controllers/redirect-controller.ts  (Rule branch — public async redirect)
             if (matchedRule) {
                 const ruleUrl = new URL(matchedRule.destination);
                 if (matchedRule.passQueryParams) {
-                    for (const [key, value] of Object.entries(req.query)) {
-                        if (value) ruleUrl.searchParams.append(key, String(value));
-                    }
+                    this.forwardQueryParams(ruleUrl, req.query as Record<string, any>);
                 }
                 if (RedirectController.DEBUG_REDIRECT) console.log(`[RULE REDIRECT] ${matchedRule.id} ...`);
```

```diff
@@ src/controllers/redirect-controller.ts  (InApp branch — public async redirect)
                 if (inAppMatch) {
                     const inAppUrl = new URL(inAppMatch.destination);
                     if (inAppMatch.passQueryParams) {
-                        for (const [key, value] of Object.entries(req.query)) {
-                            if (value) inAppUrl.searchParams.append(key, String(value));
-                        }
+                        this.forwardQueryParams(inAppUrl, req.query as Record<string, any>);
                         // Se veio do path, adicionar como utm_campaign
                         if (req.params.campaignId) {
                             inAppUrl.searchParams.append('utm_campaign', String(req.params.campaignId));
                         }
                     }
```

```diff
@@ src/controllers/redirect-controller.ts  (InApp branch — public async redirectByGroup)
                 if (inAppMatch) {
                     const inAppUrl = new URL(inAppMatch.destination);
                     if (inAppMatch.passQueryParams) {
-                        for (const [key, value] of Object.entries(req.query)) {
-                            if (value) inAppUrl.searchParams.append(key, String(value));
-                        }
+                        this.forwardQueryParams(inAppUrl, req.query as Record<string, any>);
                         if (req.params.campaignId) {
                             inAppUrl.searchParams.append('utm_campaign', String(req.params.campaignId));
                         }
                     }
```

## Typecheck

```
$ npx tsc --noEmit; echo "EXIT=$?"
EXIT=0
```

Zero erros, zero warnings.

## Notas

- A semântica do helper agora preserva `utm_term=""` (string vazia) — antes o truthy check (`if (value)`) descartava silenciosamente.
- Troca `append` → `set` evita o cenário em que a `destination` da rule já tem `utm_term=hardcoded` e o param recebido viraria duplicata na query string. Parsers que pegam o primeiro valor (Java Servlet, alguns frameworks PHP/Python) agora veem o valor *do request*, como esperado.
- Array fallback (`Array.isArray(value)`) usa o último elemento — comportamento padrão do Express para query params repetidos (`?x=a&x=b` → `['a','b']`); manda o último para alinhar com a expectativa "valor mais recente vence".
- O cast `req.query as Record<string, any>` foi necessário porque `req.query` é `ParsedQs` (recursivo) — o helper aceita `any` nos values e converte via `String(...)`.
- Hot path principal (`redirect()` L1166-1183 e `redirectByGroup()` L1298-1315) **não foi tocado**, conforme escopo.
- Lint: não existe script `lint` no `package.json` (só `start`, `start:prod`, `dev`, `dev:win`, `build`, `test`). Pulado.

## Próximos passos sugeridos

- Code review por **Hera** antes de merge.
- Auditar regras no Redis: identificar destinations com UTMs hardcoded (`utm_term=...`, `utm_content=...`, etc.) — após o fix, esses agora podem ser sobrescritos pelo request. Confirmar que isso é o comportamento desejado por produto.
- Para rules com `passQueryParams: false`, decidir se é necessária whitelist explícita (ex: passar apenas `utm_term` mantendo `utm_source` da destination). Fora do escopo deste fix.
- Setar `DEBUG_REDIRECT=1` em staging e disparar requests com `utm_term=foo` / `utm_term=` (vazio) batendo nas 3 branches pra confirmar logs corretos.
