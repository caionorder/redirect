# Code Review — Fix utm_term (Athena) — Hera

## Veredito
**APROVADO COM RESSALVAS**

O fix do controller é correto, idiomático e atende ao escopo declarado. Não há regressão na lógica do código que executa em produção. **Porém** a troca `append → set` muda a semântica de "request + destination empilhadas" para "request vence destination", o que **pode** alterar o comportamento percebido de regras existentes no Redis que tinham UTMs hardcoded nas suas `destination`. Auditoria das regras no Redis é obrigatória antes do deploy.

## Sumário executivo

- As regras "broad → utm_campaign" e os defaults de UTMs **não foram tocados** pelo fix — ficam no hot path principal (`L1184-1189` e `L1314-1319`), que só executa **após** ambos os early-returns de Rule/InApp falharem. Esses fluxos seguem idênticos. ✅
- A "regra do term" não existe no código — é dado configurado no Redis (`redirect:rules` ou `redirect:inapp_rules`). Para essas regras, o fix preserva `utm_term`, `utm_content`, etc. (era esse o objetivo). ✅
- **Não quebra nada** em qualquer regra com `passQueryParams: false` (comportamento idêntico: descarta tudo do request, mantém destination intacta). ✅
- **Muda comportamento** em regras com `passQueryParams: true` cuja `destination` já tem `utm_X=valor` hardcoded: antes ficava duplicata, agora o valor do request sobrescreve. Se isso é desejado → ✅; se a intenção era forçar o valor da destination → ❌.
- ⚠️ **Bug pré-existente NÃO introduzido pelo fix**, mas exposto: nas branches InApp, depois do `helper.set(...)`, o código ainda faz `searchParams.append('utm_campaign', req.params.campaignId)` (L1074 e L1239). Se o request chega com `?utm_campaign=Y` + path `/db/X`, a URL final tem `utm_campaign=Y&utm_campaign=X` (duplicata). Já era assim antes do fix; documentado abaixo.

## Inventário de manipulação de UTMs no controller

| Localização | UTM afetado | Operação | Origem do valor | Branch |
|---|---|---|---|---|
| `redirect-controller.ts:915-921` | TODOS de `req.query` | helper `set` | request | helper (novo) |
| `redirect-controller.ts:1053` | TODOS de `req.query` | `helper.set` via fwd | request | **Rule** (alterado pelo fix) |
| `redirect-controller.ts:1071` | TODOS de `req.query` | `helper.set` via fwd | request | **InApp/redirect** (alterado pelo fix) |
| `redirect-controller.ts:1074` | `utm_campaign` | `searchParams.append` | `req.params.campaignId` | **InApp/redirect** (intacto) |
| `redirect-controller.ts:1182` | `utm_source` | `allParams.set` se ausente | DEFAULT `'redron'` | Hot path `redirect()` |
| `redirect-controller.ts:1183` | `utm_medium` | `allParams.set` se ausente | DEFAULT `'broadcast'` | Hot path `redirect()` |
| `redirect-controller.ts:1184-1186` | `utm_campaign` | `allParams.set` | **`req.query.broad`** | Hot path `redirect()` — REGRA DO BROAD |
| `redirect-controller.ts:1187-1189` | `utm_campaign` | `allParams.set` se ausente | `linkId` ou `'direct'` | Hot path `redirect()` |
| `redirect-controller.ts:1237` | TODOS de `req.query` | `helper.set` via fwd | request | **InApp/redirectByGroup** (alterado pelo fix) |
| `redirect-controller.ts:1239` | `utm_campaign` | `searchParams.append` | `req.params.campaignId` | **InApp/redirectByGroup** (intacto) |
| `redirect-controller.ts:1312` | `utm_source` | `allParams.set` se ausente | DEFAULT `'redron'` | Hot path `redirectByGroup()` |
| `redirect-controller.ts:1313` | `utm_medium` | `allParams.set` se ausente | DEFAULT `'broadcast'` | Hot path `redirectByGroup()` |
| `redirect-controller.ts:1314-1316` | `utm_campaign` | `allParams.set` | **`req.query.broad`** | Hot path `redirectByGroup()` — REGRA DO BROAD |
| `redirect-controller.ts:1317-1319` | `utm_campaign` | `allParams.set` se ausente | `linkId` ou `'direct'` | Hot path `redirectByGroup()` |

Também: condição de match de rules e in-app rules usa `req.query.*`:
- `redirect-controller.ts:783-794` `matchRule(query, rules)` — compara `String(query[key] || '') === value` por entrada de `rule.conditions`.
- `redirect-controller.ts:1063` `utmCampaign = (req.query.utm_campaign as string) || (req.params.campaignId as string)`.
- `redirect-controller.ts:1066` `inAppRules.find(r => r.active && r.utm_campaign === utmCampaign)`.

Esses NÃO foram tocados pelo fix.

## Regra "broad → utm_campaign"

- **Localização exata**: `src/controllers/redirect-controller.ts:1184-1189` (em `redirect()`) e `:1314-1319` (em `redirectByGroup()`).
- **Como funciona**:
  ```ts
  const broad = req.query.broad as string;
  if (broad) {
      allParams.set('utm_campaign', broad);  // sobrescreve qualquer utm_campaign existente
  } else if (!allParams.has('utm_campaign')) {
      allParams.set('utm_campaign', linkId || 'direct');
  }
  ```
  Adicionalmente, `broad_clicks` é incrementado em Mongo (`:1198-1200`, `:1328-1330`).
- **Antes do fix**: idêntico.
- **Depois do fix**: **IDÊNTICO**. O fix não tocou nessas linhas.
- **Caveat operacional**: a regra do broad SÓ executa quando NENHUMA Rule do Redis bate E NENHUMA InApp rule bate. Se um request chega com `?broad=X&utm_source=facebook` e existe uma Rule com `conditions: { utm_source: 'facebook' }`, a Rule branch (L1050) faz `res.redirect(...)` e retorna — o broad nunca vira utm_campaign nesse fluxo. **Era assim antes também**, não é regressão; só vale registrar para o usuário não atribuir esse comportamento ao fix.
- **Status**: ✅ SAFE

## Regra "do term"

- **Localização exata**: NÃO existe lógica especial de `utm_term` no código.
  - `grep -rn "utm_term" src/` retorna **zero** matches.
  - `utm_term` é tratado como qualquer query param: passa pelo `forwardQueryParams` (branches Rule/InApp) ou pelo loop `allParams.set(...)` (hot path L1176-1180 e L1306-1310).
- **Como funciona (interpretação)**: a "regra do term" provavelmente é uma das três coisas:
  1. Uma `Rule` no Redis com `conditions: { utm_term: 'X' }` — a rule só dispara quando o request tem `utm_term=X` (matching).
  2. Uma `Rule` com `destination: 'https://x.com/?utm_term=hardcoded'` — força um `utm_term` específico no destino.
  3. Uma `InAppRule` cuja `destination` tem `utm_term=...` hardcoded.
- **Antes do fix**:
  - (1) matching — funcionava normalmente; matching não foi tocado pelo fix.
  - (2)/(3) com `passQueryParams: true`: request `?utm_term=req` → URL final = `?utm_term=hardcoded&utm_term=req` (DUPLICATA). Parser dependente.
  - (2)/(3) com `passQueryParams: false`: request descartado, destination intacta com `utm_term=hardcoded`.
- **Depois do fix**:
  - (1) matching — IDÊNTICO. Match continua usando `req.query` direto (`:783-794`).
  - (2)/(3) com `passQueryParams: true`: request `?utm_term=req` → URL final = `?utm_term=req` (SOBRESCREVE hardcoded).
  - (2)/(3) com `passQueryParams: false`: IDÊNTICO.
- **Status**: ⚠️ MUDANÇA DE COMPORTAMENTO em (2) e (3) com `passQueryParams: true`. Se o objetivo da regra era **forçar** `utm_term=hardcoded` ignorando o request, o fix agora deixa o request vencer.

**VERIFICAR EM PRODUÇÃO**:
```bash
# Listar regras ativas e procurar UTMs hardcoded nas destinations
redis-cli GET redirect:rules | jq '.[] | select(.active and .passQueryParams) | {id, description, conditions, destination}'
redis-cli GET redirect:inapp_rules | jq '.[] | select(.active and .passQueryParams) | {id, description, utm_campaign, destination}'

# Filtrar só as que têm utm_ hardcoded na destination
redis-cli GET redirect:rules | jq '.[] | select(.active and (.destination | test("utm_"))) | {id, description, destination}'
redis-cli GET redirect:inapp_rules | jq '.[] | select(.active and (.destination | test("utm_"))) | {id, description, destination}'
```
Para cada match, confirmar com produto: a sobrescrita pelo request é desejada?

## Análise por cenário (A–F + G/H)

| Cenário | Antes do fix | Depois do fix | Regressão? |
|---|---|---|---|
| A: rule `passQueryParams=true`, destination sem utm hardcoded | `?utm_term=req` | `?utm_term=req` | NÃO |
| B: rule `passQueryParams=true`, destination com `utm_term=hardcoded` | `?utm_term=hardcoded&utm_term=req` (duplicata, parser-dependente) | `?utm_term=req` (sobrescreve) | ⚠️ Mudança intencional; confirmar com produto |
| C: rule `passQueryParams=false` | só destination, query descartada | IDÊNTICO | NÃO |
| D: request `?utm_term=` (string vazia) | descartado (`if(value)` é falsy) | propagado como `utm_term=` literal | ⚠️ Bug fix intencional |
| E: request `?utm_x=a&utm_x=b` (array) | `append a` + `append b` (duplicata na URL final) | `set b` (só o último) | ⚠️ Mudança; alinha com "valor mais recente vence". Improvável em tráfego real. |
| F: request sem `utm_term` | utm_term ausente | utm_term ausente | NÃO |
| **G: InApp `/db/X?utm_campaign=Y`** (path E query) | helper-append `utm_campaign=Y` + path-append `utm_campaign=X` = duplicata `Y&X` | helper-set `utm_campaign=Y` + path-append `utm_campaign=X` = duplicata `Y&X` | NÃO (mesma duplicata antes/depois) — **mas ver bug pré-existente abaixo** |
| **H: InApp destination com `utm_campaign=destdefault&utm_term=destterm`, request `?utm_campaign=summer&utm_term=req`** | `utm_campaign=destdefault&utm_term=destterm&utm_campaign=summer&utm_term=req` (TODAS duplicadas) | `utm_campaign=summer&utm_term=req` (request vence) | ⚠️ Mudança significativa; mesma semântica do B |

## Hunks do diff (commit a376a69)

### Hunk 1: `forwardQueryParams` helper — L910-921
- ✅ **SAFE**
- Razão: helper isolado, puro, sem side effects. Lógica correta:
  - Aceita string vazia (filtro `=== undefined || === null`).
  - Array → último elemento (alinha com semântica Express/qs de "valor mais recente vence" em `?x=a&x=b`).
  - `String(v)` converte qualquer tipo de forma estável.
- Nit minor (não bloqueia): `Record<string, any>` é mais fraco que `ParsedQs` (o tipo real de `req.query`). Aceitável dado o escopo do fix, mas perde precisão de tipo. Não há regressão.

### Hunk 2: Rule branch — L1050-1053
- ⚠️ **MUDANÇA DOCUMENTADA**
- Razão: substituiu `for…of req.query { if(value) append }` por `forwardQueryParams(ruleUrl, req.query)`. Dois efeitos combinados:
  1. `append → set`: destination com UTM hardcoded é sobrescrita.
  2. `if (value)` (truthy) → `if (value !== undefined && value !== null)`: string vazia agora propaga.
- Era exatamente o objetivo do fix. Aprovado.

### Hunk 3: InApp branch em `redirect()` — L1068-1075
- ⚠️ **MUDANÇA DOCUMENTADA** + ⚠️ **ATENÇÃO ESPECIAL**:
- Mesma análise do Hunk 2.
- **Bug pré-existente exposto**: L1074 mantém `inAppUrl.searchParams.append('utm_campaign', String(req.params.campaignId))`. Sequência de execução:
  1. helper percorre `req.query` e faz `set('utm_campaign', req.query.utm_campaign)` se presente.
  2. Logo em seguida, `append('utm_campaign', req.params.campaignId)`.
  3. Se ambos existem (`/db/X?utm_campaign=Y`), URL final tem **DOIS** `utm_campaign` (set escreveu Y, append adicionou X).
- **Era assim antes** (`append + append`), então **não é regressão**. Mas o fix tornou mais visível porque a destination não está mais "consumindo" uma das duplicatas (cenário H).
- Decisão de produto fora do escopo: trocar L1074 para `.set('utm_campaign', req.params.campaignId)` se path deve sobrescrever request, ou manter `append` se ambos devem aparecer no destino.

### Hunk 4: InApp branch em `redirectByGroup()` — L1234-1241
- Mesma análise do Hunk 3, espelhada (`L1239` análogo a `L1074`).

## Riscos remanescentes

⚠️ **Risco 1 — destinations com UTMs hardcoded perdem precedência**
Qualquer rule no Redis (Rule ou InAppRule) cuja `destination` foi escrita com `utm_X=valor_fixo` esperando que esse valor fosse preservado MESMO quando o request manda outro, agora se comporta diferente: o request vence. Severidade depende de quantas regras se encaixam neste padrão. **Mitigação: auditoria de Redis (ver Recomendações).**

⚠️ **Risco 2 — `utm_campaign` duplicada no InApp branch (path + query)** (bug pré-existente, NÃO introduzido pelo fix)
Se request chega com `/db/X?utm_campaign=Y`, URL final tem `utm_campaign=Y&utm_campaign=X`. PHP/WordPress lê o último (X = path vence); Java Servlet/alguns frameworks lêem o primeiro (Y = query vence). Comportamento ambíguo. **Fora do escopo deste fix**, mas registrar como tech debt.

⚠️ **Risco 3 — comportamento de array agora pega último em vez de empilhar**
Request com `?utm_term=a&utm_term=b`: antes ia ao destino como `utm_term=a&utm_term=b`, agora vai como `utm_term=b`. Improvável em tráfego real (geralmente só 1 utm_term), mas se algum dashboard espera múltiplos valores, mudou.

⚠️ **Risco 4 — string vazia agora propaga**
Antes `?utm_term=` (vazio) era descartado. Agora chega ao destino como `utm_term=`. Impacto baixo (destino normalmente faz truthy check), mas registrar.

✅ **Confirmado não-risco — hot path principal intacto**
A regra `broad → utm_campaign` e os defaults `utm_source=redron` / `utm_medium=broadcast` ficam no hot path principal (`L1182-1189`, `L1312-1319`), que SÓ executa após ambos early-returns falharem. Conferido linha-a-linha; Athena não tocou.

✅ **Confirmado não-risco — match de rules e in-app rules intacto**
`matchRule()` em `L783-794` e o lookup de InApp em `L1066/L1232` continuam usando `req.query` direto. Match continua funcionando para regras com `conditions: { utm_term: 'X' }` etc.

## Recomendações antes de merge

- [ ] **Auditar Redis em produção** — listar regras ativas com `passQueryParams: true` e destinations com UTMs hardcoded:
  ```bash
  # Rules
  redis-cli GET redirect:rules | jq '.[] | select(.active and .passQueryParams and (.destination | test("utm_"))) | {id, description, conditions, destination}'

  # In-app rules
  redis-cli GET redirect:inapp_rules | jq '.[] | select(.active and .passQueryParams and (.destination | test("utm_"))) | {id, description, utm_campaign, destination}'
  ```
  Para cada match, validar com produto se sobrescrita pelo request é o comportamento desejado. Se algum hardcoded era "forçado" propositalmente, decidir entre: (a) mudar destination para não ter o hardcoded, (b) flag adicional na rule (`overrideQueryParams: false` por chave), (c) reverter o fix em casos específicos.

- [ ] **Validação manual em staging** (com `DEBUG_REDIRECT=1`):
  ```bash
  # Cenário A — fluxo normal (sem rule match), broad vira utm_campaign
  curl -sI 'https://staging.../?broad=summerX&utm_term=adset-42' | grep -i location
  # Esperado: utm_campaign=summerX, utm_term=adset-42

  # Cenário B — Rule passQueryParams=true (usar condições reais de uma rule existente)
  curl -sI 'https://staging.../?utm_source=facebook&utm_term=adset-42' | grep -i location
  # Esperado: utm_term=adset-42 chega; sem duplicata mesmo se destination tem utm_term

  # Cenário C — Rule passQueryParams=false
  curl -sI 'https://staging.../?<conditions>&utm_term=adset-42' | grep -i location
  # Esperado: utm_term NÃO chega (passQueryParams false descarta tudo)

  # Cenário D — InApp /db/campaign com utm_term no query
  curl -sI 'https://staging.../db/summer-promo?utm_term=adset-42' | grep -i location
  # Esperado: utm_campaign=summer-promo (do path), utm_term=adset-42

  # Cenário E — string vazia (regressão controlada)
  curl -sI 'https://staging.../?utm_term=&broad=X' | grep -i location
  # Esperado: utm_term= aparece literal

  # Cenário F — array (raro)
  curl -sI 'https://staging.../?utm_term=a&utm_term=b' | grep -i location
  # Esperado: utm_term=b (último)

  # Cenário G — duplicata path+query (bug pré-existente)
  curl -sI 'https://staging.../db/X?utm_campaign=Y&utm_term=t' | grep -i location
  # Esperado: utm_campaign=Y&utm_term=t&utm_campaign=X — confirmar que era assim antes também
  ```

- [ ] **Habilitar `DEBUG_REDIRECT=1`** em uma janela curta de produção pós-deploy e validar nos logs:
  - `[RULE REDIRECT]` mostra URLs com `utm_term=...` presente quando esperado.
  - `[INAPP REDIRECT]` mostra URLs sem duplicatas de destination.

- [ ] **Confirmar que nenhuma rule depende de "force destination utm"** — pergunta direta ao stakeholder de produto antes do merge.

- [ ] (Tech debt, fora do escopo) Decidir se `L1074` e `L1239` (path → utm_campaign via `append`) deveriam virar `set`. Documentar decisão.

## Arquivos lidos

- `src/controllers/redirect-controller.ts` — L35-115 (interfaces, constantes), L780-840 (matchRule, createRule), L900-1000 (helper, InApp CRUD), L1020-1340 (redirect, redirectByGroup, ambas as branches Rule/InApp e hot paths)
- `src/repositories/broad-click-repository.ts` — entendimento da regra do broad
- `src/routes/redirect-route.ts:42-43` — rota de broad-clicks
- `src/interfaces/broad-click-interface.ts` — shape do contador
- `docs/openapi.yaml:14-60, 880-1124` — spec confirma comportamento esperado de Rule/InApp e da regra do broad
- `scratchpad/agent-athena.md` — relatório do fix
- `scratchpad/agent-odysseus.md` — investigação original
- `git diff` (commit `a376a69`) — diff completo do fix
- `git log -p --all -S "forwardQueryParams"` — confirmação do commit que introduziu o helper

## Notas finais

Local Redis (`redis-cli GET redirect:rules` e `redirect:inapp_rules`) retornou `nil` — rules vivem apenas em produção, então a auditoria empírica (item 1 das recomendações) precisa ser feita lá. Sem acesso ao Redis produtivo daqui, não posso confirmar 100% se há rules com UTMs hardcoded — apenas mapear o impacto teórico caso existam.
