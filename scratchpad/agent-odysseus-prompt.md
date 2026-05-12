Você é Odysseus (Explore Agent). Trabalhe em /Users/caionorder/Dev/redirect.

# Contexto do projeto

Projeto Node.js/TypeScript de redirecionamento (curtos -> destinos finais) que repassa parâmetros UTM. Stack: TypeScript, Express (provavelmente), Mongo. Estrutura em src/{controllers,services,repositories,middleware,routes,schemas,utils}. Memórias Obsidian relevantes em ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/ (perf, cache-control, routing-fix da Athena recentes).

# Task — INVESTIGAÇÃO READ-ONLY

O usuário reporta: "em algum momento no nosso redirecionamento estamos perdendo o utm_term". O utm_term entra na requisição mas NÃO chega ao destino final. Encontrar EXATAMENTE onde está sendo perdido.

# Plano de investigação obrigatório

1. **Mapear o fluxo completo de uma requisição de redirect**: entry route -> controller -> service -> repository -> resposta (Location header). Liste arquivos:line ranges.

2. **Buscar todas as referências a UTMs no código**:
   - grep recursivo por: `utm_term`, `utm_`, `utm`, `term`, `query`, `searchParams`, `URLSearchParams`, `req.query`, `parse_qs`, `qs.parse`, `url.parse`
   - Liste cada ocorrência com path:line e snippet de 3 linhas de contexto

3. **Identificar onde os query params são lidos da request**: como o código pega `req.query`, parsing manual, etc.

4. **Identificar onde a URL de destino é montada**: concatenação, template literal, URL/URLSearchParams append. Procurar listas/whitelists/arrays de utm permitidos — utm_term pode estar faltando da whitelist.

5. **Buscar lógica de cache**: se a URL final é cacheada (Redis/memória) por shortcode SEM levar utm_term em conta, requests subsequentes com utm_term diferente retornam URL stale. Conferir keys de cache.

6. **Buscar schemas/validators** (Zod, Joi, class-validator) que possam fazer strip de campos não-listados (`.strict()`, `stripUnknown: true`). Se utm_term não está no schema, é dropado.

7. **Conferir nginx.conf**: regras de proxy_pass, args, `$args`, `$query_string`, headers que possam reescrever a URL antes de chegar no Node.

8. **Conferir middlewares**: qualquer um que normalize/sanitize query string.

9. **Conferir migrations recentes e código de tracking/analytics** que possa estar lendo utm_term mas não persistindo.

10. **Dockerfile e Jenkinsfile**: só se houver indício de build-time substitution de query.

# Output OBRIGATÓRIO

Salve EM scratchpad/agent-odysseus.md um relatório técnico no formato:

```
# Investigação utm_term — Odysseus

## TL;DR
<1-2 frases: onde está sendo perdido e por quê>

## Fluxo de uma request /:shortcode?utm_term=X
1. nginx (nginx.conf:LL) — <o que faz com query>
2. Express entry (path:LL) — ...
3. middleware X (path:LL) — ...
4. controller (path:LL) — ...
5. service (path:LL) — ...
6. repository (path:LL) — ...
7. resposta Location (path:LL) — ...

## Pontos suspeitos encontrados
### Suspeito 1: <título>
- Arquivo: path:LL
- Snippet:
  ```ts
  <código>
  ```
- Por que perde utm_term:
- Severidade: ALTA/MÉDIA/BAIXA
- Evidência: ...

### Suspeito 2: ...

## Causa raiz mais provável
<arquivo:linha + explicação>

## Como reproduzir
<comando curl/passos>

## Sugestão de fix (NÃO IMPLEMENTAR — só descrever)
<diff conceitual>

## Arquivos lidos durante investigação
- path1
- path2
...
```

# Regras

- **READ-ONLY**. NÃO edite NADA. NÃO crie patch. Só investigue e produza o relatório.
- Não execute o servidor.
- Se precisar de comandos: use Read, Bash com grep/find/rg, Bash com curl (apenas para parse simples de URL, sem hit em produção).
- Vasculhe TODO o repo — não desista cedo. utm_term é uma string específica e bem rastreável.
- Considere normalização de case (`utm_Term`, `UTM_TERM`), aliases, e parsing que faz lowercase só dos conhecidos.
- Considere bibliotecas externas (axios, got, node-fetch) que possam fazer re-encoding e droppar params.
- Considere ordering: query string parser pode estar com `arrayLimit` ou similar que descarta após N keys.

# Passo final OBRIGATÓRIO

Depois de salvar scratchpad/agent-odysseus.md, rode EXATAMENTE este comando (literal, sem alterar):

cmux wait-for --signal done-odysseus-utmterm-investigation
