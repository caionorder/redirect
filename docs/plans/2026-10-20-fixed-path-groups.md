# Plano — Grupos com path fixo (`fixedPath`)

Data: 2026-10-20 · Branch: `feat/fixed-path-groups` (base `94bea50`) · Autor: Daedalus (plano, sem implementação)

## Objetivo

Permitir que um grupo de domínios redirecione sempre para um **path fixo** (ex.: `/first-hello/`),
rotacionando apenas o **domínio** entre os `domains[]` do grupo. Caso de uso imediato: 22 slugs
em produção (`first-hello`, `match-waiting`, …), todos com `bestRpsMode: true`, os mesmos 7
domínios, e `fixedPath = /<slug>/`.

## Não-objetivos

- Não mudar nada para grupos sem `fixedPath` (comportamento byte-a-byte idêntico ao atual).
- Não ordenar domínios por desempenho (RPS/eCPM por domínio) nos grupos `fixedPath` — rotação simples.
- Não adicionar auth à API de domain-groups (problema pré-existente, fora de escopo — ver Riscos).
- Não validar `domains[]` como hostname (pré-existente; fora de escopo).
- Não criar os 22 grupos em produção dentro do PR — isso é passo operacional pós-deploy (seção final).
- Sem refatoração de `getBestRpsLink`, `redirect()` (grupo main) ou do repositório de clicks.

## Decisão de design (ajuste em relação à direção do MAIN)

A direção proposta era aplicar `fixedPath` "em TODOS os ramos" (explore, bestRps, rank, fallback,
exhausted). **Proposta: short-circuit único no topo do fluxo de ranking de `redirectByGroup`.**

Justificativa:
1. Os 22 grupos são novos: **não têm ranking** de posts (`/?p=<postId>` só existe para posts com
   receita GAM do dia). Sem ranking o código atual cai no `else` (fallback aleatório) — os ramos
   explore/bestRps/rank nem rodam. A escolha de domínio "na ordem do ranking" seria vazia ou
   cobriria só parte dos 7 domínios.
2. Mesmo com ranking, a ordem é por **post**, irrelevante para um path fixo. Explorar posts
   (`explore_*`) em um grupo de path fixo não faz sentido: o destino não é o post.
3. Um único ramo novo é a menor mudança segura: não toca os 5 ramos existentes (zero risco de
   regressão para grupos sem `fixedPath`), economiza 1 `INCR` Redis + leitura de ranking por request.
4. Bônus operacional: o cron `executeAllGroups` deve **pular** grupos `fixedPath` — senão 22 grupos ×
   7 domínios geram a cada 15 min queries GAM + fetch de posts WP + pageviews (bestRpsMode) inúteis.

### Escolha de domínio (grupos `fixedPath`)

Rotação por IP reaproveitando o **mesmo set Redis de visitados** do bestRps
(`visitor:<slug>:<ip>:<hora>`, TTL 3600, via `getVisitorKey` / `addVisitedDomain`):
- `unvisited = groupDomains − visited`.
- Se `unvisited` não vazio → **aleatório uniforme entre `unvisited`**; marca como visitado.
- Se todos visitados (exhausted) → aleatório entre todos os `groupDomains` (não marca; mesmo
  comportamento do exhausted atual).
- Sem Redis (`redisClient == null`) ou erro no `smembers` → `visited = ∅` → aleatório puro.

Por que aleatório entre não visitados e não ordem fixa/round-robin global: ordem fixa jogaria
todo primeiro clique no `groupDomains[0]` (distribuição enviesada); round-robin global exigiria
mais 1 `INCR` por request. Aleatório entre não visitados dá distribuição uniforme entre os 7 e
garante que o mesmo IP passa pelos 7 domínios antes de repetir na hora — sem custo extra.

Aplica-se independentemente de `bestRpsMode` (o `fixedPath` tem precedência); `bestRpsMode`
só influencia o prefixo do linkId (abaixo). Os 22 grupos terão `bestRpsMode: true`.

## Regra de validação exata do `fixedPath`

Função pura `validateFixedPath(input: unknown)` em `src/utils/fixed-path.ts`:

- `typeof input === 'string'`, senão erro.
- Comprimento 2..200 (checado ANTES da regex).
- Regex (anchored, sem flag `i` necessária pois a classe já cobre maiúsculas):
  ```
  ^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$
  ```
  Forma não ambígua de propósito: **não** usar `^\/(?:[...]+\/?)+$` — quantificador aninhado com
  `/` opcional causa backtracking exponencial (ReDoS) em entradas como `/aaaa…a!` vindas da API pública.
  i.e. começa com exatamente uma `/`, seguida de 1+ segmentos de caracteres **unreserved** (RFC 3986:
  letras, dígitos, `.`, `_`, `~`, `-`), separados por uma única `/`, barra final opcional.
  Isso rejeita automaticamente: `//` (inclusive `//evil.com` protocol-relative), esquema
  (`http:`/`javascript:` — `:` não permitido), host, espaços/tabs/CR/LF, `?`, `#`, `%`
  (sem percent-encoding → sem `%2f`/`%0d%0a`), `\`, `@`, `/` sozinha e string vazia.
- Rejeitar segmentos `.` e `..` (checagem extra: `input.split('/').some(s => s === '.' || s === '..')`).
- Sem normalização silenciosa (não adiciona/remove barra final; não faz trim) — armazena exatamente
  o que passou na validação. Retorno: `{ ok: true, value } | { ok: false, error }`.

Montagem: `buildFixedPathUrl(domain, fixedPath) => \`https://${domain}${fixedPath}\``. Como
`fixedPath` validado nunca contém `?`, o código existente de query params usará `?` como separador
e repassa os params + UTMs default normalmente (sem mudança).

## Arquivos a tocar

| Arquivo | Mudança |
|---|---|
| `src/utils/fixed-path.ts` (novo) | `validateFixedPath`, `buildFixedPathUrl`, `pickFixedPathDomain` (puras) |
| `src/utils/fixed-path.test.ts` (novo) | testes `node:test` (padrão de `domain-normalize.test.ts`) |
| `src/schemas/domain-group-schema.ts` | `IDomainGroup.fixedPath?: string`; `ICreateDomainGroup.fixedPath?: string` |
| `src/repositories/domain-group-repository.ts` | `create` (~l.33) persiste `fixedPath` se presente; `updateBySlug` (~l.48) aceita `fixedPath?: string \| null` → `$set` / `$unset` |
| `src/services/domain-group-service.ts` | assinatura de `updateGroup` (~l.181) inclui `fixedPath?: string \| null`. Cache: nada a mudar — `getGroupConfig` devolve o documento inteiro de `groupConfigCache`, já refrescado em `create/update` (e TTL 60s) |
| `src/controllers/domain-group-controller.ts` | `create` (~l.28) e `update` (~l.60) leem e validam `fixedPath` |
| `src/controllers/redirect-controller.ts` | `executeAllGroups` (~l.210) pula grupos `fixedPath`; novo `private async getFixedPathLink(...)` perto de `getBestRpsLink` (~l.893); short-circuit em `redirectByGroup` (~l.1578) |
| `docs/openapi.yaml` | `DomainGroup.fixedPath` (~l.1061), body do POST (~l.296), body do PUT (~l.355) + exemplos; menção em `/{slug}` (~l.144) |

### Detalhe por arquivo

**`src/utils/fixed-path.ts`**
```ts
export type FixedPathValidation = { ok: true; value: string } | { ok: false; error: string };
export function validateFixedPath(input: unknown): FixedPathValidation;
export function buildFixedPathUrl(domain: string, fixedPath: string): string;
/** null se domains vazio. rand injetável para teste (default Math.random). */
export function pickFixedPathDomain(
    domains: string[], visited: Set<string>, rand?: () => number
): { domain: string; exhausted: boolean } | null;
```

**Repository `create`**: `...(data.fixedPath ? { fixedPath: data.fixedPath } : {})` — grupos sem o
campo continuam sem a chave no documento (compat). **`updateBySlug`**: se `typeof update.fixedPath === 'string'`
→ `$set.fixedPath`; se `update.fixedPath === null` → `$unset: { fixedPath: '' }`; `undefined` → não toca.

**Controller `create`**: se `fixedPath !== undefined` → `validateFixedPath`; inválido → `400 { error }`.
**Controller `update`**: `fixedPath` aceita string (validada) ou `null` (remove). A guarda
"At least one of …" passa a considerar `fixedPath !== undefined`; mensagem atualizada para
`slug, name, bestRpsMode, or fixedPath`.

**`executeAllGroups`**: antes de `executeProcessForGroup(slug)`, `const cfg = await getGroupConfig(slug); if (cfg?.fixedPath) continue;`
(log uma vez por ciclo opcional, sob `DEBUG_REDIRECT`). O endpoint manual `/api/process` (~l.809)
pode seguir igual (invocação manual; se quiser, aplicar o mesmo skip — opcional, baixo impacto).

**`getFixedPathLink(clientIp, slug, groupDomains, fixedPath, bestRpsMode)`** →
`{ url, domain, linkId, logType }`:
1. `visited` via `smembers(getVisitorKey(clientIp, slug))` com try/catch (mesmo padrão do `getBestRpsLink`).
2. `pickFixedPathDomain(groupDomains, visited)`.
3. Se `!exhausted` → `await this.addVisitedDomain(clientIp, slug, domain)` (já trata erro e TTL).
4. URL via `buildFixedPathUrl`; linkId conforme tabela abaixo.

**`redirectByGroup`** — inserir logo após calcular `clientIp` (~l.1575), **antes** de `getBestLinksMapForGroup`:
```ts
const groupConfig = await this.domainGroupService.getGroupConfig(slug);
if (groupConfig?.fixedPath) {
    ({ url: redirectUrl, domain, linkId, logType } =
        await this.getFixedPathLink(clientIp, slug, groupDomains, groupConfig.fixedPath, !!groupConfig.bestRpsMode));
} else {
    /* bloco atual inteiro (ranking/explore/bestRps/rank/fallback), sem alterações */
}
```
O `getGroupConfig` interno do bloco atual (~l.1581) pode reutilizar a variável de cima (remove a
2ª chamada; é cache em memória, mudança semântica nula). Tudo depois (log, params, UTMs,
`incrementClick`, `Cache-Control`, `res.redirect`) fica inalterado. In-app rules continuam
avaliadas antes (inalterado).

## Comportamento por ramo

| Situação | Grupo sem `fixedPath` | Grupo com `fixedPath` |
|---|---|---|
| in-app rule casa `utm_campaign` | inalterado | inalterado (avaliado antes) |
| ranking existe, fatia explore | `explore_*` → post | **não se aplica** — sem explore |
| ranking existe, bestRpsMode | 1º domínio não visitado do ranking → post | aleatório entre não visitados → `https://<d><fixedPath>` |
| ranking existe, não bestRps | `rank<i>_*` → post | idem linha acima |
| todos domínios visitados | `bestrps_exhausted_*` → `/random` | aleatório entre todos → `https://<d><fixedPath>` |
| sem ranking | `fallback_*` → `/random` | idem (ranking nem é consultado) |
| Redis indisponível | inalterado | aleatório puro entre os domínios |
| `groupDomains` vazio | 503 (antes de tudo) | 503 (inalterado) |

## Formato de linkId

| Caso | `bestRpsMode: true` | `bestRpsMode` falso/ausente |
|---|---|---|
| domínio não visitado | `bestrps_<slug>_<domain>_fixed` | `fixed_<slug>_<domain>` |
| exhausted | `bestrps_exhausted_<slug>_<domain>` (formato já existente) | `fixed_<slug>_<domain>` |

Impacto:
- `getClickCountsBySuffixes` (`redirect-click-repository.ts` ~l.228) casa sufixos `_<domain>_<postId>`
  vindos do ranking. `_<domain>_fixed` nunca coincide com `postId` numérico → **sem contaminação** do
  `/api/rank`. Slugs só têm `[a-z0-9-]` (sem `_`), então o split por `_` não desalinha.
- `/api/rank` e `/api/rank-by-domain` só leem rankings `main`/`db` → sem impacto.
- `linkId` vira `utm_campaign` default quando não vier na URL (comportamento existente) — destino
  recebe `utm_campaign=bestrps_first-hello_supertrabalho.com_fixed`. Aceitável; se Caio preferir
  outro valor, é ajuste trivial.
- Nenhum prefixo existente renomeado.

## Estratégia de testes (`src/utils/fixed-path.test.ts`)

`validateFixedPath`:
- válidos: `/first-hello/`, `/first-hello`, `/a/b/c/`, `/last-chance-tonig/`, `/A_b.c~d/`.
- inválidos: `''`, `/`, `first-hello/` (sem barra inicial), `//evil.com`, `//evil.com/x`,
  `/a//b`, `https://evil.com/`, `javascript:alert(1)`, `/a b/`, `/a\tb`, `/a\r\nLocation: x`,
  `/a?x=1`, `/a#x`, `/%2f%2fevil.com`, `/a\\b`, `/@evil.com`, `/../x`, `/a/./b`, string de 201 chars,
  não-string (`123`, `null`, `{}`).
`buildFixedPathUrl`: `('supertrabalho.com','/first-hello/')` → `https://supertrabalho.com/first-hello/`;
  sanity com `new URL(...)`: `host === domain` e `pathname === fixedPath`.
`pickFixedPathDomain` (com `rand` determinístico):
- domains vazio → `null`.
- nenhum visitado → retorna domínio do array, `exhausted: false`; com `rand=()=>0` e `()=>0.999` cobre 1º/último.
- 6 de 7 visitados → retorna exatamente o restante, `exhausted: false`.
- todos visitados → `exhausted: true`, domínio ∈ domains.
- visited com domínio fora do grupo (ex.: grupo editado) → ignorado.
- simulação: iterando 7 vezes adicionando ao `visited` → cobre os 7 domínios sem repetição.

Controller/repo: sem infra de teste HTTP/Mongo no repo (precedente do PR #3) — cobertos por build
+ curl local. Executor deve rodar `npm test` completo (5 arquivos).

## Riscos

1. **Open redirect / injeção de header**: mitigado pela allowlist de caracteres (sem `:`, `//`, `%`,
   CR/LF, `\`, `@`) + host sempre vindo de `groupDomains`. **Risco residual pré-existente**: a API de
   domain-groups é pública sem auth — qualquer um pode criar grupo com domínio arbitrário (já era
   possível antes desta feature). Recomendar Aegis no review e registrar como follow-up.
2. **Cache**: `getGroupConfig` usa `groupConfigCache` (doc completo) → `fixedPath` entra automaticamente;
   refresh imediato em create/update na instância que recebeu a chamada, TTL 60s nas demais.
   `getActiveSlugsSync` (catch-all `/:param` em `app.ts` ~l.119) só é atualizado por `refreshCache`;
   em instância única é imediato após o POST. Em multi-réplica, um slug novo pode demorar até o
   próximo `ensureCache` (o cron de 15 min o dispara) — **pré-existente**, mas relevante ao criar os 22:
   validar com curl após criar.
3. **Wipe do Redis no deploy**: só perde os sets de visitados (rotação recomeça) — sem dependência
   de ranking/cron, os grupos `fixedPath` funcionam imediatamente após o deploy.
4. **Compatibilidade**: grupos sem `fixedPath` → ramo `else` é o código atual sem alteração; o único
   delta é o `getGroupConfig` subir algumas linhas (cache em memória). `create` não grava a chave
   quando ausente.
5. **Carga do cron**: sem o skip, 22 grupos novos multiplicariam chamadas GAM/WP/pageviews a cada 15 min.
   Com o skip, custo zero.
6. **Slug colidindo com rotas**: slugs `api`, `db`, `main`, `health`, `docs` são sombreados por rotas
   existentes — nenhum dos 22 colide.
7. **Mesma lista de 7 domínios em 22 grupos**: `getAllDomains` (CSP) concatena com duplicatas — já
   acontece hoje com grupos sobrepostos; sem impacto funcional.

Nível de risco sugerido: **Médio** (mudança em hot path de redirect + input público que vira URL de
destino) → Hera (code-reviewer) + Aegis (security-reviewer) antes do commit.

## Passos de verificação

1. `npm run build` — sem erros de tipo.
2. `npm test` — todos os testes (inclusive `fixed-path.test.ts`) passando.
3. Local (`npm run dev`, Mongo/Redis locais):
   ```bash
   B=http://localhost:3000
   D='["in.dopeaaps.com","supertrabalho.com","empregacascavel.com","noticiasexclusivas.net","creditosaibamais.com","dopeaaps.com","appmobile4u.com"]'
   curl -s -XPOST $B/api/domain-groups -H 'content-type: application/json' \
     -d "{\"slug\":\"first-hello\",\"name\":\"first-hello\",\"domains\":$D,\"fixedPath\":\"/first-hello/\"}"
   curl -s -XPUT $B/api/domain-groups/first-hello -H 'content-type: application/json' -d '{"bestRpsMode":true}'
   # 8 requests do mesmo IP: 7 primeiros devem cobrir os 7 domínios sem repetir, todos com /first-hello/?utm_...
   for i in $(seq 1 8); do curl -s -o /dev/null -w '%{redirect_url}\n' $B/first-hello; done
   # campaignId e query params repassados
   curl -s -o /dev/null -w '%{redirect_url}\n' "$B/first-hello/abc?foo=1"
   # validação: todos devem retornar 400
   for p in '//evil.com' 'https://evil.com/' '/a?x=1' '/a b/' '/%2f' '/../x' '/'; do
     curl -s -XPUT $B/api/domain-groups/first-hello -H 'content-type: application/json' -d "{\"fixedPath\":\"$p\"}"; echo; done
   # remover fixedPath -> volta ao comportamento atual (fallback /random sem ranking)
   curl -s -XPUT $B/api/domain-groups/first-hello -H 'content-type: application/json' -d '{"fixedPath":null}'
   curl -s -o /dev/null -w '%{redirect_url}\n' $B/first-hello
   # regressão: grupo existente sem fixedPath segue igual
   curl -s -o /dev/null -w '%{redirect_url}\n' $B/db
   ```
4. Conferir no Mongo: `redirects_clicks` com `link_id` `bestrps_first-hello_<domain>_fixed`.
5. Conferir log do cron (com `DEBUG_REDIRECT=1`) que `first-hello` não é processado.

## Pós-deploy (operacional, com aprovação do Caio — mutação de produção)

Script (não commitado) com loop pelos 22 slugs: `POST /api/domain-groups` com `slug`, `name`,
os 7 `domains` e `fixedPath: "/<slug>/"`, seguido de `PUT {bestRpsMode: true}`; depois um curl por
slug em `https://redirect.belnk.in/<slug>` conferindo `Location`. Antes, `GET /api/domain-groups`
para garantir que nenhum dos 22 slugs já existe (409 em duplicado).

## Rollback / forward-fix

Rollback = revert do PR. Documentos com `fixedPath` no Mongo ficam inertes (campo ignorado pelo
código antigo → grupos caem no fallback `/random`). Para desligar só um grupo: `PUT {fixedPath:null}`
ou `DELETE /api/domain-groups/<slug>`.

## Critério de pronto

- `npm run build` e `npm test` verdes, com `fixed-path.test.ts` cobrindo os casos acima.
- Curl local demonstra: rotação dos 7 domínios por IP sem repetição na hora, path fixo, query params/UTMs
  repassados, 400 em todos os paths maliciosos, `fixedPath:null` restaura comportamento atual, `/db` inalterado.
- Cron pula grupos `fixedPath`.
- openapi atualizado (POST, PUT, schema `DomainGroup`).
- Review Hera + Aegis sem findings blocker/critical.
