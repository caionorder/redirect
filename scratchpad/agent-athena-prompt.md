Você é Athena (Frontend Senior Developer). Trabalhe em /Users/caionorder/Dev/redirect.

# Contexto

Projeto Node.js/TypeScript de redirecionamento. Há lógica que detecta `?language=en|es|...` e prefixa o pathname do destino com `/en`, `/es`, etc para uma whitelist de domínios em `INVERTED_LANG_DOMAINS`. O usuário quer **desativar essa lógica** mantendo o código comentado (decisão tomada pelo usuário: opção "Comentar bloco" — reversível em segundos).

# Tarefa — DESATIVAÇÃO MÍNIMA

Risco: **MÉDIO** (hot path em produção). Mudança puramente cosmética/de comportamento — sem refactor.

## O que comentar

Arquivo: `src/controllers/redirect-controller.ts`

1. **L1141-1166** — Bloco completo de inversão de idioma:
   ```ts
   // Domínios com lógica invertida de idioma (APENAS estes recebem prefixo).
   // Fast-path: extrair hostname por substring e checar Set antes de pagar new URL().
   const hostStart = redirectUrl.indexOf('//');
   let hostname = '';
   if (hostStart !== -1) {
       const afterScheme = redirectUrl.slice(hostStart + 2);
       const pathStart = afterScheme.indexOf('/');
       hostname = pathStart === -1 ? afterScheme : afterScheme.slice(0, pathStart);
       const qIdx = hostname.indexOf('?');
       if (qIdx !== -1) hostname = hostname.slice(0, qIdx);
       hostname = hostname.toLowerCase();
   }
   const isInvertedDomain = RedirectController.INVERTED_LANG_DOMAINS.has(hostname);

   // Só adiciona prefixo de idioma nos domínios invertidos — todos os outros vão direto
   if (isInvertedDomain) {
       const url = new URL(redirectUrl);
       if (!language || language === 'en') {
           url.pathname = `/en${url.pathname}`;
           redirectUrl = url.toString();
       } else if (language !== 'pt') {
           url.pathname = `/${language}${url.pathname}`;
           redirectUrl = url.toString();
       }
       // Se language=pt, nao adiciona nada (acesso direto)
   }
   ```

   Envolver em bloco de comentário `/* ... */` com nota no topo:
   ```
   /*
    * [DESATIVADO 2026-05-12] Inversão de idioma desligada por solicitação do produto.
    * Para reativar: descomentar este bloco. Toda request passa direto ao redirectUrl sem prefixo.
    */
   ```

2. **L1168-1172** — O log de debug `[${logType}]${langInfo}` referencia `isInvertedDomain` e `language`:
   ```ts
   if (RedirectController.DEBUG_REDIRECT) {
       const langInfo = isInvertedDomain ? (language ? ` [${language.toUpperCase()}]` : ' [EN]') : '';
       console.log(`[${logType}]${langInfo} ${domain} -> ${redirectUrl}`);
   }
   ```
   Como `isInvertedDomain` deixa de existir, o tsc vai quebrar. Simplificar o log para:
   ```ts
   if (RedirectController.DEBUG_REDIRECT) {
       console.log(`[${logType}] ${domain} -> ${redirectUrl}`);
   }
   ```
   Comentar a versão original no MESMO bloco /* */ acima, ou inline:
   ```ts
   // [DESATIVADO 2026-05-12] log de idioma removido junto com a inversão
   ```

3. **L1100** — `const language = req.query.language as string;` agora fica unused. Se tsc reclamar (`noUnusedLocals`), prefixar com underscore: `const _language = req.query.language as string;` ou comentar a linha também.
   - **Verificar primeiro**: rode `npx tsc --noEmit` ANTES de tocar nessa linha. Se passar, deixa como está. Se reclamar, prefixe com `_` ou comente.

4. **L107-114** — `INVERTED_LANG_DOMAINS` const fica unused. Mesmo critério: rode tsc primeiro; se quebrar, comente o bloco inteiro com nota:
   ```ts
   // [DESATIVADO 2026-05-12] Whitelist mantida para referência caso a inversão seja reativada.
   // private static readonly INVERTED_LANG_DOMAINS = new Set<string>([
   //     'appmobile4u.com',
   //     ...
   // ]);
   ```

## NÃO faça

- NÃO refatore.
- NÃO mude o hot path principal de UTMs (fix recente da Athena anterior).
- NÃO toque em `redirectByGroup()` (não tem essa lógica lá).
- NÃO crie testes (regra global: só com pedido explícito).
- NÃO faça commit.
- NÃO rode o servidor.

## Validação

- Após editar, rode `npx tsc --noEmit`. Precisa retornar 0 erros.
- Verifique que o redirect ainda funciona sintaticamente (sem rodar — só lendo).

# Entregáveis obrigatórios

1. Aplicar a desativação acima.
2. tsc clean.
3. Salvar `scratchpad/agent-athena.md`:

```
# Desativação inversão de idioma — Athena

## Mudanças aplicadas
- src/controllers/redirect-controller.ts:LL — bloco de inversão comentado
- src/controllers/redirect-controller.ts:LL — log simplificado
- src/controllers/redirect-controller.ts:LL — (se aplicável) language / INVERTED_LANG_DOMAINS comentados

## Diff resumo
<hunks>

## Typecheck
<output de tsc --noEmit>

## Como reativar
<1 frase: "descomentar bloco em L... e restaurar log original">

## Notas
<surpresas/decisões>
```

4. Criar memória Obsidian em `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-12_HH-MM_disable-lang-inversion-athena.md` com YAML frontmatter (date, project: redirect, agent: athena, type: implementation, tags: [redirect, language, deactivation]) + corpo descrevendo a mudança e como reativar.

# Passo final OBRIGATÓRIO

Depois de salvar scratchpad/agent-athena.md E a memória Obsidian, rode EXATAMENTE:

cmux wait-for --signal done-athena-lang-disable-1747000200
