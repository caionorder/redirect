# Desativação inversão de idioma — Athena

## Mudanças aplicadas
- `src/controllers/redirect-controller.ts:1141-1172` — bloco completo de inversão de idioma envolvido em `/* ... */` com cabeçalho `[DESATIVADO 2026-05-12]` e instrução de reativação. O bloco original (extração de hostname + checagem `INVERTED_LANG_DOMAINS` + prefixação `/en|/<lang>` no pathname) ficou preservado linha-a-linha dentro do comentário.
- `src/controllers/redirect-controller.ts:1174-1177` — log de debug simplificado. Removida a variável local `langInfo` (que dependia de `isInvertedDomain`, agora inexistente). Linha de origem comentada inline.

Não tocado (intencional):
- `src/controllers/redirect-controller.ts:1100` — `const language = req.query.language as string;` mantido. `tsc --noEmit` passa porque `tsconfig.compilerOptions.noUnusedLocals` é `false`. Variável continua tipada e disponível caso a inversão volte.
- `src/controllers/redirect-controller.ts:107-114` — `INVERTED_LANG_DOMAINS` mantido pelo mesmo motivo. Whitelist permanece como referência para reativação.
- `redirectByGroup()` e demais hot paths: intocados.

## Diff resumo
1 arquivo, +35/-30 (`git diff --stat`). Hunks:

```
@@ src/controllers/redirect-controller.ts:1141 @@
-            // Domínios com lógica invertida de idioma (APENAS estes recebem prefixo).
-            // Fast-path: extrair hostname por substring e checar Set antes de pagar new URL().
-            const hostStart = redirectUrl.indexOf('//');
-            ...
-            const isInvertedDomain = RedirectController.INVERTED_LANG_DOMAINS.has(hostname);
-
-            if (isInvertedDomain) {
-                const url = new URL(redirectUrl);
-                if (!language || language === 'en') {
-                    url.pathname = `/en${url.pathname}`;
-                    ...
-                } else if (language !== 'pt') {
-                    url.pathname = `/${language}${url.pathname}`;
-                    ...
-                }
-            }
-
-            if (RedirectController.DEBUG_REDIRECT) {
-                const langInfo = isInvertedDomain ? (language ? ` [${language.toUpperCase()}]` : ' [EN]') : '';
-                console.log(`[${logType}]${langInfo} ${domain} -> ${redirectUrl}`);
-            }
+            /*
+             * [DESATIVADO 2026-05-12] Inversão de idioma desligada por solicitação do produto.
+             * Para reativar: descomentar este bloco (inclusive o log com langInfo abaixo).
+             * Toda request passa direto ao redirectUrl sem prefixo de idioma.
+             *
+             * <bloco original linha a linha>
+             */
+
+            // [DESATIVADO 2026-05-12] log de idioma removido junto com a inversão
+            if (RedirectController.DEBUG_REDIRECT) {
+                console.log(`[${logType}] ${domain} -> ${redirectUrl}`);
+            }
```

## Typecheck
```
$ npx tsc --noEmit
(exit 0, sem output)
```
Baseline pré-edit também era limpo. Mudança não introduz erros.

## Como reativar
Descomentar o bloco `/* ... */` em `src/controllers/redirect-controller.ts:1141-1172` (restaurar como código TypeScript válido) e substituir o log atual de L1174-1177 pelo original com `const langInfo = ...`. `INVERTED_LANG_DOMAINS` e `language` continuam disponíveis — sem mais mudanças necessárias.

## Notas
- `noUnusedLocals: false` no `tsconfig.json` foi decisivo: permitiu manter `language` e `INVERTED_LANG_DOMAINS` intocados, deixando o caminho de reativação trivial (1 bloco para descomentar + 1 log para restaurar).
- Hot path principal de UTMs (`allParams` em diante) preservado integralmente.
- Sem refactor, sem testes, sem commit — escopo restrito conforme briefing.
