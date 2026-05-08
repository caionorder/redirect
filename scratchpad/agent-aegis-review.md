# Aegis — Security Review (Fase 1 perf impl)

Reviewer: Aegis (security-reviewer)
Date: 2026-05-08
Scope: diff Fase 1 da otimizacao de performance — `nginx.conf`, `src/app.ts`, `src/config/database.ts`, `src/config/redis.ts`, `src/controllers/redirect-controller.ts`, `src/repositories/redirect-click-repository.ts`, `src/routes/redirect-route.ts`, novas migrations.

## Verdict

**REQUEST CHANGES** — duas issues introduzidas/exacerbadas pelo diff que precisam de mitigacao antes de subir pra producao com confianca:

1. Iframe HTML response deixou de ter CSP (HIGH — converte stored XSS de "bloqueado" para "executavel").
2. HSTS removido do hot path (MED — first-visit downgrade).

Mais a remontagem do panorama pre-existente que continua nao mitigado: credencial Mongo exposta + `/api` sem auth + sem rate limit.

Codigo do diff em si (configs Mongo/Redis/migrations/nginx) e seguro — varias mudancas sao **positivas** sob lente de seguranca (`error_log debug → warn` por exemplo).

---

## Threat model rapido

Servico publico de redirect HTTP atras de nginx + Cloudflare implicita (TLS terminacao no nginx). Stack stateless, sem login, sem cookies de sessao no dominio de redirect. Hot path = 302 navegacional. Surface secundaria = `/api/*` (CRUD de rules, in-app rules, domain groups, stats) — **sem autenticacao**, exposto publicamente.

Adversarios relevantes:
- Atacante na network ate o cliente (MITM em primeira visita HTTP).
- Atacante anonimo na internet enviando POST/DELETE em `/api/*` para envenenar regras de redirect (open redirect arbitrario, stored XSS em iframe).
- Atacante derrubando Redis (atraves de DDoS ou exploit) — todo `await` no hot path agora lanca, mas hot path tem try/catch global e cai em fallback `https://useuapp.com/random`. Nao e DoS amplification real.

A diff de Fase 1 nao introduz novas portas, nao muda autorizacao, nao mexe em sanitizacao. Ela **reduz a superficie de cabecalhos de seguranca aplicados ao hot path** — esse e o eixo onde aparecem os finds reais.

---

## Findings — CRITICAL

Nenhum CRITICAL **introduzido pela diff**. Os CRITICAL existentes sao pre-existentes (vide secao dedicada abaixo).

---

## Findings — HIGH

### H1 — Iframe HTML response perdeu CSP, converte stored XSS de bloqueado em executavel
- **Vetor**: `src/controllers/redirect-controller.ts:1059` (`redirect()`) e `:1220` (`redirectByGroup()`) chamam `res.send(this.generateIframeHtml(finalUrl))`. O template (linha 891) interpola URL diretamente: `<iframe src="${url}" allowfullscreen></iframe>`.
- O `finalUrl` vem de `new URL(inAppMatch.destination).toString()`. `inAppMatch.destination` e setado por POST `/api/inapp-rules` (`createInAppRule` linha 948-976) **sem validacao de scheme**. `new URL("javascript:alert(document.cookie)")` succeeds, e `.toString()` preserva o scheme `javascript:`. Browsers (Chrome/Firefox/Safari) executam `javascript:` em `iframe[src]`.
- **Antes do diff**: helmet global aplicava CSP `defaultSrc 'self'; frameSrc 'self' *; scriptSrc 'self' 'unsafe-inline'`. CSP **bloqueava** execucao de `javascript:` URI no iframe.
- **Depois do diff**: helmet so em `/api`. As respostas de iframe (saem do hot path `/`, `/db`, `/:slug`) nao tem mais CSP. Browser usa default permissivo → JS executa no contexto de `redirect.belnk.in`.
- **Impacto**: stored XSS no dominio do servico. `redirect.belnk.in` nao tem cookies HttpOnly proprios ate onde inspecionei, entao roubo direto de sessao do servico de redirect e nulo. **Mas**:
  - phishing/brand impersonation (renderizar fake login no dominio do produto)
  - se houver cookies de outro subdominio em `*.belnk.in` com `Domain=.belnk.in`, ataque consegue subdomain takeover de cookie
  - exfiltracao de query params sensiveis que tenham passado pelo redirect
- **Exploitabilidade**: o que torna este finding HIGH e nao MED e que `/api/inapp-rules` POST e **publico, sem auth, sem rate limit** (vide P3, P4 abaixo). Atacante anonimo: `curl -X POST /api/inapp-rules -d '{"utm_campaign":"x","destination":"javascript:..."}' ` → todo trafego com `?utm_campaign=x` vira XSS.
- **Recomendacao** (1-2 linhas):
  - Validacao no `createInAppRule`/`createRule`: `new URL(destination).protocol` deve ser `'http:'` ou `'https:'`. Reject 400 caso contrario.
  - **OU** setar header inline antes do `res.send(generateIframeHtml(...))`: `res.setHeader('Content-Security-Policy', "default-src 'none'; frame-src https:; style-src 'unsafe-inline'")`. Cobre o caso onde a regra e criada por canal interno futuro.
  - **Idealmente ambos** — defesa em profundidade.

### H2 — `/api/*` sem autenticacao + sem rate limit (combinada com H1 vira critical)
- **Vetor**: `src/app.ts:62-99` monta `apiRouter` sem nenhum middleware de auth. `createRule`, `createInAppRule`, `deleteRule`, `deleteInAppRule`, `addDomains`, `removeDomains`, todos `getStats`/`getRank`/etc — abertos. Rate limit (`src/config/rate-limit.ts`) existe mas esta `// commented out` no `app.ts:8`.
- **Pre-existente** ao diff, mas o diff **mexeu nessa montagem do router** (`apiRouter` reorganizado, ordem de mount mudou). Como o reviewer ta passando aqui, vale flagar — o ato de tocar o router seria a oportunidade natural de adicionar `apiRouter.use(authMiddleware)` na frente.
- **Impacto**: enumeration, envenenamento de rules (open redirect arbitrario para o atacante), enable do H1.
- **Recomendacao**: minimo viavel = `X-Admin-Token` header check em todos os mutating endpoints (`POST`/`PUT`/`DELETE`) usando `crypto.timingSafeEqual` com `process.env.ADMIN_TOKEN`. Adicionar `limiter` no `apiRouter`. Long term: JWT/oauth.

---

## Findings — MED

### M1 — HSTS (`Strict-Transport-Security`) removido do hot path
- **Vetor**: helmet inclui HSTS por default (`max-age=15552000; includeSubDomains`). Diff moveu helmet para `/api` (`src/app.ts:64-74`). 302s em `/`, `/db`, `/:slug` agora respondem **sem** `Strict-Transport-Security`.
- **Impacto**: cliente que fizer primeira visita via `http://redirect.belnk.in/?utm_x=y` recebe 301 do nginx → HTTPS. OK, **mas** o 302 final do Node nao instala HSTS no browser. Proxima visita (mesmo sem MITM ativo) se atacante conseguir intercepter rede do cliente, redirect inicial pra HTTP nao tem HSTS pra forcar upgrade local. Real-world: **fraco** porque a maioria dos navegadores moderna ja faz preload da lista da Mozilla, e CDN/edge geralmente seta HSTS no nivel de proxy. Mas dependendo da operacao (Cloudflare nao intercepta esse dominio?), perde.
- **Recomendacao**: setar HSTS no nginx (`add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;`) na bloco `server` do `nginx.conf`. Uma linha, zero overhead, cobre TODAS as responses (302 e API). Dispensa restaurar helmet no hot path.

### M2 — `enableOfflineQueue: false` em ioredis transforma falha de Redis em 500 visivel
- **Vetor**: `src/config/redis.ts:10`. Sem queue offline, `redis.get/set/incr/sadd` durante outage do Redis lancam `Error: Stream isn't writeable`. Hot path `redirect()` e `redirectByGroup()` tem try/catch global que faz `res.redirect('https://useuapp.com/random')` — entao usuario nao ve 500. **Mas** os endpoints de `/api/*` (createRule, getStats, etc) propagam para o `errorHandler`.
- **Verificado** em `src/middleware/error-handler.ts:17-30`: para errors que nao sao `ApiError`, retorna `'Internal server error'` generico. `stack` so em `NODE_ENV === 'development'`. Em prod, **nao ha info disclosure**. OK.
- **Impacto residual**: error log no console (`console.error('Error details:', { message, stack })`) sempre loga stack — em pipe Docker stdout, qualquer pessoa com acesso aos logs ve. Aceitavel.
- **Recomendacao**: sem acao obrigatoria. Considerar futuramente: classificar erros de connectividade (Redis/Mongo) como `ApiError.serviceUnavailable(503)` ao inves do 500 generico para nao confundir monitoring.

### M3 — HTTP/2 no nginx (`listen 443 ssl http2`) — CVE-2023-44487 Rapid Reset
- **Vetor**: `nginx.conf:56`. HTTP/2 tem CVE-2023-44487 (HTTP/2 Rapid Reset DoS). Mitigado em nginx >= 1.25.3.
- **Impacto**: se nginx em prod estiver < 1.25.3, atacante anonimo derruba o nginx via fluxo de RST_STREAM frames.
- **Recomendacao**: rodar `nginx -v` em prod, confirmar >= 1.25.3. Se nao, atualizar antes de promover essa mudanca de http1.1 → http2.

### M4 — `app.set('trust proxy', 1)` + extracao manual de `X-Forwarded-For` permite spoof se Node receber direto
- **Vetor**: `src/app.ts:20` e controller linhas 1066, 1227: `(req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress`. Pega o **primeiro** elemento do header, sem checar trust proxy.
- Em deploy normal, nginx adiciona `X-Forwarded-For: $remote_addr` (e `proxy_add_x_forwarded_for` concatena), entao primeiro elemento e o IP real. **Mas** se atacante consegue acessar Node em `127.0.0.1:6969` direto (porta exposta na host? container network?), pode setar qualquer IP. Visto isolamento `server 127.0.0.1:6969` no nginx.conf:2, alvo direto so com acesso a host.
- **Pre-existente** — diff nao toca isso, mas vale notar que cabe na mesma janela de hardening.
- **Recomendacao**: usar `req.ip` (que respeita `trust proxy`) em vez de header parsing manual. Confirmar que porta 6969 nao esta exposta no `docker run` (`-p 6969:6969` ausente).

---

## Findings — LOW

### L1 — CORS `origin: '*'` com `credentials: true` invalido
- **Vetor**: `src/app.ts:81-86`. RFC: browsers rejeitam `Access-Control-Allow-Origin: *` quando `credentials: true`. Configuracao **nao funciona** no browser; e incoerente.
- **Impacto**: nenhum direto (browsers protegem). Mas e signal de mau hardening — convem definir origin allowlist.
- **Recomendacao**: setar `CORS_ORIGIN` no `.env` para o dominio admin real, remover fallback `'*'`. Ou se admin for usado de varios origins, listar via array.

### L2 — Migration `001-redirects-links-indexes.ts` usa fallback nao-unique
- **Vetor**: `migrations/001-redirects-links-indexes.ts:27-31`. Se duplicatas em `(domain, url)` existem, cria indice **nao** unique e loga warning.
- **Cenario teorico**: atacante com acesso ao Mongo insere doc duplicado **antes** da migration rodar → indice fica nao-unique permanentemente, mascara qualquer ataque futuro de envenenamento por inserir varias urls iguais. Pre-condicao (acesso direto ao Mongo) ja e CRITICAL — se acontece, este nao e o pior dos problemas.
- **Recomendacao**: log do warning ja faz a coisa certa. Operador deve revisar amostra de duplicatas antes de aceitar `unique=false`.

### L3 — `redis.set/get` sem prefixo de namespace explicito
- **Vetor**: chaves `redirect:rules`, `redirect:inapp_rules`, `redirect:best_links_map:*`, `visitor:*`, `redirect:global_counter:*` compartilham espaco com qualquer outra app no mesmo Redis.
- Pre-existente. Em deploy isolado (Redis dedicado por servico) e zero risco. Compartilhado com outros servicos pode haver collision. Nao introduzido pelo diff.
- **Recomendacao**: nenhuma para esta revisao.

---

## Pre-existentes nao mitigados (citar e parar — nao e diff atual)

### P1 — CRITICAL: Credencial Mongo `b019C7Fyc4P35hg8` exposta
- `Jenkinsfile:30` (em claro, plain text no source).
- `Dockerfile:19` (`COPY .env .env` → credencial em image layer permanente, vazia para qualquer um que pull a imagem).
- **Status**: Hephaestus (Fase 2) mapeou a remediacao. Ainda nao implementada nem rotacionada (.env continua presente em `/Users/caionorder/Dev/redirect/.env`).
- **Acao**: rotacionar a credencial **antes** de aplicar a Fase 2 do plano. Nao adianta remover do Dockerfile sem rotacao — a credencial atual ja vazou. Tarefa do operador, nao deste diff.

### P2 — Sem auth em `/api/*` (vide H2)
- Pre-existente, exacerba H1.

### P3 — Rate limit comentado (vide H2)
- `src/app.ts:8` import comentado, nunca aplicado.

### P4 — `getRules()` / `saveRules()` aceitam JSON arbitrario sem validacao de tipo
- `req.body.conditions` e `req.body.destination` salvos no Redis sem validacao. Atacante anonimo (P2) pode injetar campos extras, override de keys, etc. Combinado com H1 ja e exploit suficiente; isolar este e parte da mesma remediacao.

---

## Recomendacoes ordenadas por prioridade

1. **(P1) Rotacionar credencial Mongo agora**. Nao depende de codigo, depende de ops. Ate isso acontecer, qualquer commit de hardening e teatro.
2. **(H1 + H2) Adicionar auth em `/api`** + **validar scheme HTTP/HTTPS no `destination` de `createRule`/`createInAppRule`**. Patch pequeno, mata vetor de stored XSS.
3. **(M1) HSTS no nginx**: adicionar `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;` no bloco `server` 443 do `nginx.conf`. Uma linha, fecha M1.
4. **(M3) Confirmar versao do nginx em prod >= 1.25.3** antes de habilitar http2.
5. **(H2) Reativar `limiter`** no `apiRouter` — descomentar import + `apiRouter.use(limiter)` no topo, ajustar window/max para algo razoavel (atual `windowMs: 60*100000` = 100 minutos, `max: 50000` — esta efetivamente sem limite).
6. **(L1) Definir `CORS_ORIGIN` real** em prod, remover fallback `*`.
7. **(M4) Trocar parsing manual de `X-Forwarded-For` por `req.ip`** depois que itens acima forem feitos.

---

## O que estava bom

- `error_log debug → warn` no nginx — **positivo de seguranca** (debug log de nginx pode logar headers/cookies que vazariam pra logs).
- `enableOfflineQueue: false` mais `commandTimeout: 2000` em ioredis — comportamento `fail-fast` reduz blast radius de outage, **bom de seguranca/observabilidade**.
- Mongo configs (`waitQueueTimeoutMS`, `serverSelectionTimeoutMS`) tambem fail-fast — bom.
- `RedirectController` virou singleton, eliminou cron duplicado — reduz race conditions concorrentes que poderiam ser exploradas em sequencia.
- `console.log` per-request removidos do hot path — **menos info disclosure** nos logs (linha de IP + URL final por request era leaky).
- Migration 001 cuidadosa com duplicatas pre-existentes (warning + fallback nao-unique).

---

## Output

Scratchpad: `scratchpad/agent-aegis-review.md`
Memoria Obsidian: `redirect/2026-05-08_09-50_perf-impl-review-aegis.md`
