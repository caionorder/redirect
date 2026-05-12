# Investigação utm_term — Odysseus

## TL;DR

O **hot path normal de redirect propaga `utm_term` corretamente** (loop `for…of Object.entries(req.query)` em `redirect-controller.ts:1167-1171` e `:1299-1303`). A perda só acontece quando uma **`Rule` (Redis key `redirect:rules`) ou `InAppRule` (`redirect:inapp_rules`) ativa bate com o request** — esses branches têm 3 bugs: (1) `if (value)` derruba `utm_term=""`, (2) `searchParams.append` em destination com `utm_term` hardcoded gera duplicata, e (3) regras criadas com `passQueryParams: false` descartam tudo. A causa raiz mais provável é (3): alguma regra/in-app rule ativa está com `passQueryParams: false` e o request casa nela.

---

## Fluxo de uma request `/:slug?utm_term=X`

1. **nginx** (`nginx.conf:31-46`) — `location / { proxy_pass http://redirect_backend; }` repassa intacto, incluindo `$request_uri` (não há `rewrite`, `args`, manipulação de query). **Não perde nada aqui.**

2. **Express entry** (`index.ts:11`, `src/app.ts:18-167`) — `createApp()` monta:
   - `/` → `redirectController.redirect()` (`app.ts:110`)
   - `/db` → `redirectController.redirectByGroup(req, res, 'db')` (`app.ts:113`)
   - `/db/:campaignId` → idem (`app.ts:116`)
   - `/:param` → catch-all que checa slugs ativos; se ativo e ≠ 'main' → `redirectByGroup`, senão `redirect()` (`app.ts:119-127`)
   - `/:param/:campaignId` → idem (`app.ts:129-137`)
   - `/api/*` (router separado com `helmet`, `cors`, `compression`, `express.json`, `express.urlencoded`, `morgan`) — **NÃO** é o hot path. Hot path nem passa por esses middlewares (`app.ts:69`).
   - **Nenhum middleware mexe em `req.query`.** Express parser default é `qs` (sem `strict`, `arrayLimit` default 20, `parameterLimit` 1000). `utm_term` sobrevive.

3. **`redirect()`** (`src/controllers/redirect-controller.ts:1026-1200`):
   - **L1028-1031**: favicon short-circuit (204).
   - **L1034-1048**: ⚠️ `getRules()` + `matchRule()`. Se alguma regra ativa bate → executa branch da regra (PODE PERDER utm_term, ver Suspeito 1).
   - **L1051-1084**: ⚠️ Checa `utm_campaign` contra `getInAppRules()`. Se bate → branch da in-app rule (PODE PERDER utm_term, ver Suspeito 2).
   - **L1086-1129**: Resolve domínio + ranking (Redis `redirect:best_links_map`, fallback `/random`).
   - **L1144-1157**: Inversão de idioma só para domínios em `INVERTED_LANG_DOMAINS` (não afeta query string — `url.toString()` preserva `?p=…`).
   - **L1166-1183**: ✅ Constrói `allParams` com TODOS os `req.query` (`if (value !== undefined && value !== null)` — permite até string vazia). Defaults só pra `utm_source`/`utm_medium`/`utm_campaign`. **utm_term passa intacto.**
   - **L1182-1183**: `separator = redirectUrl.includes('?') ? '&' : '?'` — concat com `${allParams.toString()}`.
   - **L1193-1194**: `res.setHeader('Cache-Control','private, no-store')` + `res.redirect(finalRedirectUrl)` (302).

4. **`redirectByGroup()`** (`redirect-controller.ts:1206-1331`):
   - **Mesma lógica que `redirect()`**, com uma diferença crítica: **NÃO** checa `matchRule()` (`getRules()`). Só checa `getInAppRules()` (L1220-1249).
   - L1297-1315 = mirror exato de L1166-1183. utm_term passa.

5. **Resposta**: HTTP 302 com header `Location: <finalRedirectUrl>`. Express não modifica querystring.

---

## Pontos suspeitos encontrados

### Suspeito 1: Rule branch (matched) — `passQueryParams=false` derruba TUDO (incluindo utm_term)

- **Arquivo**: `src/controllers/redirect-controller.ts:1037-1048`
- **Snippet**:
  ```ts
  if (matchedRule) {
      const ruleUrl = new URL(matchedRule.destination);
      if (matchedRule.passQueryParams) {
          for (const [key, value] of Object.entries(req.query)) {
              if (value) ruleUrl.searchParams.append(key, String(value));
          }
      }
      if (RedirectController.DEBUG_REDIRECT) console.log(`[RULE REDIRECT] ${matchedRule.id} (${matchedRule.description}) -> ${ruleUrl.toString()}`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.redirect(ruleUrl.toString());
      return;
  }
  ```
- **Por que perde utm_term**:
  1. Se a regra foi criada com `passQueryParams: false` (veja `createRule()` L812-840, default `passQueryParams !== false`), **nenhum** param do request é repassado. utm_term junto com tudo é descartado.
  2. Quando `passQueryParams: true`, `if (value)` é truthy check — string vazia `""` é filtrada (não é o caso típico de utm_term, mas é inconsistente com o path principal que usa `value !== undefined && value !== null`).
  3. `searchParams.append` (em vez de `set`): se a `destination` (URL fixa salva no Redis sob `redirect:rules`) já contém `?utm_term=algo` hardcoded, a URL final fica `…?utm_term=hardcoded&utm_term=real`. PHP/WordPress (parser `$_GET`) pega o **último** (real wins, ok), mas qualquer parser que pegue o primeiro (Java Servlet, alguns frameworks Go/Rust) retorna o hardcoded — utm_term efetivamente perdido.
- **Severidade**: **ALTA** (causa raiz mais provável)
- **Evidência**: regras vivem no Redis (`REDIRECT_RULES_KEY = 'redirect:rules'`), criadas via `POST /api/rules`. Diferente do código, **não dá pra auditar sem ler o Redis**. O endpoint `GET /api/rules` (L799-807) lista todas.

### Suspeito 2: InApp rule branch — mesmos 3 bugs do Suspeito 1, em DOIS lugares

- **Arquivos**:
  - `redirect-controller.ts:1057-1083` (em `redirect()`)
  - `redirect-controller.ts:1224-1248` (em `redirectByGroup()`)
- **Snippet** (redirect()):
  ```ts
  if (inAppMatch) {
      const inAppUrl = new URL(inAppMatch.destination);
      if (inAppMatch.passQueryParams) {
          for (const [key, value] of Object.entries(req.query)) {
              if (value) inAppUrl.searchParams.append(key, String(value));
          }
          if (req.params.campaignId) {
              inAppUrl.searchParams.append('utm_campaign', String(req.params.campaignId));
          }
      }
      ...
  ```
- **Por que perde utm_term**:
  - Mesmas 3 razões do Suspeito 1.
  - Trigger: regra in-app bate quando `req.query.utm_campaign === rule.utm_campaign` OR `req.params.campaignId === rule.utm_campaign` (L1055). Se o usuário usa `?utm_campaign=summer-promo&utm_term=adset-42` e existe in-app rule com `utm_campaign: 'summer-promo'` e `passQueryParams: false`, **utm_term morre aqui**.
  - Note também o ramo do iframe (L1078-1081): `res.send(this.generateIframeHtml(finalUrl))` — devolve HTML com `<iframe src="${url}">`. **A URL do iframe carrega `?utm_term=…` se chegou em `finalUrl`, mas browsers crawlers (Facebook/Twitter) podem não seguir a iframe URL completa.** Se o destino captura utm_term via JS (não server-side), pode ser perdido por causa do iframe. Investigar caso o usuário tenha in-app rules ativas.
- **Severidade**: **ALTA** (segunda causa raiz mais provável)
- **Evidência**: `INAPP_RULES_KEY = 'redirect:inapp_rules'`. Listar via `GET /api/inapp-rules` (L953).

### Suspeito 3: Refactor de `utmParams` para `allParams` em commit 2811978

- **Arquivo**: `redirect-controller.ts:1166-1183` e `:1298-1315`
- **Snippet (atual)**:
  ```ts
  const allParams = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
      if (value !== undefined && value !== null) {
          allParams.set(key, String(value));
      }
  }
  if (!allParams.has('utm_source')) allParams.set('utm_source', 'redron');
  if (!allParams.has('utm_medium')) allParams.set('utm_medium', 'broadcast');
  ```
- **Por que NÃO perde utm_term**: o filtro `value !== undefined && value !== null` permite strings vazias e qualquer valor. utm_term entra em `allParams` 1:1.
- **Mas há um lateral em ARRAYS**: se request chega como `?utm_term=foo&utm_term=bar`, `qs` parsea como `value = ['foo','bar']`. `String(value)` vira `'foo,bar'`. Destino recebe `utm_term=foo,bar` — não é "perda", é corrupção. Pouco provável, porque normalmente só vem 1 utm_term.
- **Severidade**: **BAIXA** — não é a causa raiz, mas vale documentar.

### Suspeito 4: Favicon check com `req.url.includes('favicon')`

- **Arquivo**: `redirect-controller.ts:1028` e `:1208`
- **Snippet**:
  ```ts
  if (req.path.includes('favicon') || req.url.includes('favicon')) {
      res.status(204).end();
      return;
  }
  ```
- **Por que NÃO é o problema do utm_term reportado**: só dispara 204 se a string `favicon` aparecer em qualquer lugar da URL. Improvável que `utm_term` tenha "favicon" dentro.
- **Severidade**: **BAIXA / falso positivo** — só listo por escrutínio.

### Suspeito 5: Concatenação manual de `allParams.toString()` à `redirectUrl`

- **Arquivo**: `redirect-controller.ts:1182-1183` e `:1314-1315`
- **Snippet**:
  ```ts
  const separator = redirectUrl.includes('?') ? '&' : '?';
  const finalRedirectUrl = `${redirectUrl}${separator}${allParams.toString()}`;
  ```
- **Por que NÃO perde**: `redirectUrl` é `https://${domain}/?p=${postId}` (já tem `?`, separator vira `&`). Se for `/random`, vira `?`. Em ambos os casos `allParams` (contendo utm_term) é apendado.
- **Risco lateral**: se `redirectUrl` contiver um `#` (fragmento) — `https://x.com/page#anchor` — `URLSearchParams.toString()` viria depois do `#`, criando URL inválida. **Não é o caso atual** (rankings sempre geram `?p=…` ou `/random`), mas vale registrar.
- **Severidade**: **BAIXA** (não aplica hoje).

---

## Causa raiz mais provável

**`src/controllers/redirect-controller.ts:1037-1048` (rule branch) ou `:1057-1083`/`:1224-1248` (in-app rule branch) com `passQueryParams: false` configurado.**

Sem acesso ao Redis (chaves `redirect:rules` e `redirect:inapp_rules`) não dá pra confirmar 100%, mas a evolução do código bate:

1. Em commit 2811978 (29-Mar-2026), o autor refatorou a propagação de UTMs do path principal para repassar **tudo** (de uma whitelist explícita para `for…of req.query`). **Mas não fez o mesmo refactor nos branches de Rule e In-App Rule.** Eles continuaram com `if (value)` + `append` + dependência de `passQueryParams`.
2. A auditoria anterior em Obsidian (`2026-03-27_11-00_auditoria-utm-term-redirect.md`) foi escrita ANTES desse refactor e concluiu "tudo ok" baseada no padrão da whitelist explícita — não cobre o estado atual.
3. A reclamação "utm_term está sendo perdido" é compatível com o padrão de uma regra ativa engatilhar o branch alternativo.

**Verificações para confirmar (READ-ONLY, fora do escopo deste agent)**:

```bash
# Listar regras ativas
curl -s https://redirect.belnk.in/api/rules | jq '.rules[] | select(.active) | {id, conditions, passQueryParams, destination}'
curl -s https://redirect.belnk.in/api/inapp-rules | jq '.rules[] | select(.active) | {id, utm_campaign, passQueryParams, destination}'

# Olhar direto no Redis (servidor)
redis-cli GET redirect:rules | jq '.[] | select(.active) | {id, conditions, passQueryParams, destination}'
redis-cli GET redirect:inapp_rules | jq '.[] | select(.active) | {id, utm_campaign, passQueryParams, destination}'
```

Procurar por:
- regras com `passQueryParams: false`
- destinations que já contenham `utm_term=...` hardcoded
- in-app rule cujo `utm_campaign` casa com requests do tráfego onde se perdeu utm_term

---

## Como reproduzir

```bash
# Cenário 1 — path principal (DEVE manter utm_term)
curl -sI 'https://redirect.belnk.in/?utm_source=meta&utm_term=adset-42&broad=campaignX' | grep -i location

# Cenário 2 — força match de rule (substitua condition que existir no Redis)
# Se há rule { conditions:{utm_source:'facebook'}, passQueryParams:false }:
curl -sI 'https://redirect.belnk.in/?utm_source=facebook&utm_term=adset-42' | grep -i location

# Cenário 3 — força match de in-app rule
# Se há in-app rule com utm_campaign='summer-promo':
curl -sI 'https://redirect.belnk.in/?utm_campaign=summer-promo&utm_term=adset-42' | grep -i location
curl -sI 'https://redirect.belnk.in/db/summer-promo?utm_term=adset-42' | grep -i location
```

Observar o `Location:` retornado em cada cenário. Se o cenário 1 mantém `utm_term` mas 2 ou 3 perde, achamos o branch.

Setar `DEBUG_REDIRECT=1` no servidor (env var, `redirect-controller.ts:105`) liga logs `[RULE REDIRECT]`, `[INAPP REDIRECT]`, `[IFRAME]` que mostram exatamente qual branch executou e a URL final.

---

## Sugestão de fix (NÃO IMPLEMENTAR — só descrever)

Unificar a propagação de query params nos 3 branches usando a mesma lógica do path principal, e trocar `append` por `set` para evitar duplicatas com a destination:

```ts
// Helper centralizado
private forwardQueryParams(targetUrl: URL, query: Record<string, any>): void {
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        const v = Array.isArray(value) ? value[value.length - 1] : value; // pega último
        targetUrl.searchParams.set(key, String(v)); // SET, não append — sobrescreve hardcoded
    }
}
```

Aplicar em:
- `redirect-controller.ts:1039-1043` (rule branch)
- `redirect-controller.ts:1059-1066` (in-app branch em redirect())
- `redirect-controller.ts:1227-1234` (in-app branch em redirectByGroup())

Também repensar a semântica de `passQueryParams: false`: hoje descarta TUDO (incluindo utm_term que o cliente provavelmente quer preservar). Considerar nova flag `dropTrackingParams` que só descarta params NÃO-UTM, ou aceitar uma whitelist `forwardOnly: ['utm_term', 'utm_source', ...]`.

Diff conceitual (sem aplicar):

```diff
- if (matchedRule.passQueryParams) {
-     for (const [key, value] of Object.entries(req.query)) {
-         if (value) ruleUrl.searchParams.append(key, String(value));
-     }
- }
+ if (matchedRule.passQueryParams) {
+     this.forwardQueryParams(ruleUrl, req.query);
+ }
```

---

## Arquivos lidos durante investigação

- `nginx.conf` — proxy_pass, sem rewrite/args
- `index.ts` — entry, cluster bootstrap
- `src/app.ts` — montagem de rotas, middlewares (`/api` separado do hot path)
- `src/controllers/redirect-controller.ts` — controller principal (1563 linhas, todo o fluxo de UTM)
- `src/routes/redirect-route.ts` — sub-router /api
- `src/middleware/error-handler.ts` — error handler global (não toca query)
- `src/config/domains.ts` — lista de domínios, `generateRandomPath()`
- `src/schemas/link-schema.ts`, `click-schema.ts`, `domain-group-schema.ts` — shapes de Mongo, sem stripUnknown
- `src/services/builder-service.ts` — pipeline Mongo de eCPM (não toca request)
- `src/services/process-service.ts` — processamento de dados de ranking (não toca request)
- `src/repositories/broad-click-repository.ts` — contador `broad_clicks`, recebe só broadId
- `docs/openapi.yaml` — spec da API
- `/Users/caionorder/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-03-27_11-00_auditoria-utm-term-redirect.md` — auditoria anterior (estado pré-refactor, **desatualizada**)
- `git log -p -S "utm_term"` — confirmou que commit `2811978d30` (29-Mar-2026) removeu a whitelist explícita de UTMs do path principal mas **não tocou nos branches de rule/in-app**
