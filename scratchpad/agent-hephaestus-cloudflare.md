# Hephaestus — Cloudflare ativado em redirect.plus

Data: 2026-05-08 (~15:42 BRT)
Persona: Hephaestus (sysadmin-engineer)
Risco: **MEDIO** (mudou rota de tráfego de produção). Mantido backup completo + rollback documentado.
Escopo: APENAS `redirect.plus` (1 zona). Outros domínios continuam direto.

## TL;DR

**Funcionou. TTFB caiu de 656ms → 284ms p50 (-57%), 706ms → 448ms max.**
Rotação de redirects preservada (8 requests = 8 destinos diferentes). CF-Cache-Status: DYNAMIC em 100% (não cacheia, como queriamos). Origin segue saudável (rt=2-6ms).

## Mudanças aplicadas (zone 9e888ec259cc5f0d1188e157af1f01dc)

| # | Setting | De | Para |
|---|---|---|---|
| 1 | browser_cache_ttl | 14400 | **0** (Respect Existing Headers) |
| 2 | min_tls_version | 1.0 | **1.2** |
| 3 | ssl | full | **strict** |
| 4 | always_use_https | off | **on** |
| 5 | 0rtt | off | **on** |
| 6 | DNS A `redirect.plus` proxied | false (cinza) | **true (laranja)** |

Settings que NAO mudei (e razao):
- `cache_level=aggressive` — sem Page Rule cacheando dynamic, ele so cacheia static. Seguro.
- `http3=on` — ja estava ativo (otimo).
- `http2=on` — ja estava ativo.
- `brotli=on` — ja estava ativo (irrelevante pra 302 mas zero overhead).
- `security_level=medium` — nao toquei. Bot Fight Mode permanece off (mataria FB IAB).
- Page Rules — vazio. Nao criei nenhuma.

## Comparacao TTFB (50 amostras cada)

| Metric | Baseline (DNS direto) | Pos-CF | Reducao |
|---|---|---|---|
| TCP p50 | 218.3 ms | **28.5 ms** | -87% |
| TLS p50 (cumul.) | 437.2 ms | **62.2 ms** | -86% |
| **TTFB p50** | **656.1 ms** | **284.0 ms** | **-57%** |
| TTFB p90 | n/d | 298.5 ms | — |
| TTFB p95 | 683.7 ms | 306.6 ms | -55% |
| TTFB p99 | 697.5 ms | 445.3 ms | -36% |
| TTFB max | 706.4 ms | 447.5 ms | -37% |
| Status 302 | 50/50 | 50/50 | OK |

Decomposicao do 284ms p50 pos-CF:
- Cliente → CF edge (GRU/SP): TCP 28ms + TLS 34ms = **62ms** (1 RTT TCP + 1 RTT TLS local)
- CF edge → origin (CA): ~220ms (1 RTT cross-continental)
- Total: 62 + 220 + (server <5ms) ≈ **285ms** ✓ bate

Pra usuarios reais na India (RTT cliente→CF Mumbai = ~30-50ms; CF→origin ainda ~220ms): cold connection deve cair de ~750ms pra **~280-320ms**.

## Validacoes pos-mudanca

- **Rotacao preservada**: 8 requests sequenciais retornaram 8 destinos diferentes (odiahoje.com, supertrabalho.com, cincosete.com, bank-credits.biz, lavoriinitalia.com, feedapp.com.br, empregabrasilia.me, appmobile4u.com).
- **CF-Cache-Status: DYNAMIC** em 100% das amostras → CF nao esta cacheando o redirect.
- **Origin recebe trafego real** via CF (vi requests no `redirect.access-perf.log` com IPs CF edge 172.71.x.x e 104.22.x.x).
- **rt no nginx**: 2-6ms (igual ao pre-mudanca), `cs` (connection_requests) ate 26 — **CF mantem keepalive na origin**, otimo.
- **Direct origin bypass (--resolve)**: 665ms TTFB — origin nao mudou.
- Nenhum erro 5xx, 525, 526 ou 1xxx (CF errors) observado.

## Alerta operacional — IP do cliente

A app usa `req.ip` em pelo menos:
- `redirect-controller.ts:1156, 1292` — Redis `recent:<ip>` (ja removido na Phase 1.8 segundo plano, mas verificar)
- logs/metrics

Com CF na frente, sem ajuste, `req.ip` agora retorna o **IP do CF edge**, NAO o cliente real. Razao: nginx tem `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` + Express tem `app.set('trust proxy', 1)`. CF preenche `CF-Connecting-IP` mas a app nao le.

**Solucao recomendada (NAO apliquei — fora do escopo desta task):**

Opcao A — nginx (zero codigo): trocar `proxy_set_header X-Real-IP $remote_addr` por `proxy_set_header X-Real-IP $http_cf_connecting_ip` no server block do redirect, **APENAS** se redirect.plus passar 100% via CF. Nao faz sentido fazer global porque outros dominios podem nao ter CF.

Opcao B — Express: ler `req.headers['cf-connecting-ip']` direto no controller quando o host for redirect.plus.

Opcao C — `app.set('trust proxy', 2)` mais lista IPs CF: deixar Express pular dois hops (nginx + CF). Riscos: precisa atualizar lista de IPs CF (eles publicam em https://www.cloudflare.com/ips/).

**Por agora**: trafego de redirect.plus que flui via CF tem `req.ip` = CF edge IP. Se isso afeta dedup/rate-limit/analytics, agir antes de migrar mais dominios pra CF.

## Backup e rollback

Snapshot completo salvo em:
`/Users/caionorder/Dev/redirect/scratchpad/cloudflare-backup/`

Arquivos (timestamp `2026-05-08_15-38-45`):
- `zone_*.json` — info da zona
- `dns_records_*.json` — todos os DNS records (com proxied=false original)
- `pagerules_*.json` — Page Rules (vazio)
- `settings_*.json` — todos os settings antes
- `RECORD_ID.txt` — id `881a86b1d51e5de2292f316e308c8b0b` do A record
- `ROLLBACK_*.txt` — cheat-sheet com curl de revert pra cada mudanca

### Rollback instantaneo (caso quebre)

Mata o CF em 1 chamada (volta DNS pra cinza):
```bash
export CF_KEY="<rotacionar e nao usar mais essa chave>"
curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/9e888ec259cc5f0d1188e157af1f01dc/dns_records/881a86b1d51e5de2292f316e308c8b0b" \
  -H "X-Auth-Email: caio@caionorder.com" \
  -H "X-Auth-Key: $CF_KEY" \
  -H "Content-Type: application/json" \
  -d '{"proxied": false}'
```

Reverter um setting (exemplo browser_cache_ttl):
```bash
curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/9e888ec259cc5f0d1188e157af1f01dc/settings/browser_cache_ttl" \
  -H "X-Auth-Email: caio@caionorder.com" \
  -H "X-Auth-Key: $CF_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value":14400}'
```

## ACAO DE SEGURANCA

A Global API Key da conta Cloudflare (`bcfe21c6...feda`) foi exposta nesta sessao. **Rotacionar imediatamente em https://dash.cloudflare.com/profile/api-tokens.** Idealmente migrar pra um API Token escopado (so a zona redirect.plus, so DNS+Settings:Edit) em vez de Global Key.

## Proximos passos

1. **MONITORAR 24-48h** o `redirect.access-perf.log` em prod. Validar que rt continua pequeno e que nao ha picos de 526/525.
2. **Ajustar IP cliente** (alerta acima) antes de migrar mais dominios.
3. Se OK, **migrar os outros 15 dominios** do redirect (perfil.im, meeting.boats, redirect.services, redirect.wtf, rechat.life, etc.) pra CF — repetir a mesma checklist. Pode ser feito em batch.
4. Manter logs de `redirect.access-perf.log` ativos. **Adicionar `$http_cf_connecting_ip`** no log_format pra ter o IP cliente real nos logs. Ja deixo proposta de patch do log_format pra task seguinte.

## Arquivos gerados

- `scratchpad/agent-hephaestus-cloudflare.md` — este relatorio
- `scratchpad/perf/vec-CF-after.tsv` — 50 amostras pos-CF
- `scratchpad/perf/vec-A-external.tsv` — baseline pre-CF
- `scratchpad/cloudflare-backup/*.json` — snapshot do estado anterior
- `scratchpad/cloudflare-backup/ROLLBACK_*.txt` — instrucoes de revert
- `scratchpad/cloudflare-backup/RECORD_ID.txt` — id do DNS record
