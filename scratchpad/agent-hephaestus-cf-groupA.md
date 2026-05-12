# Hephaestus — Grupo A migrado pro Cloudflare

Data: 2026-05-08 ~16:00 BRT
Persona: Hephaestus (sysadmin-engineer)
Risco: MEDIO (mudou rota de trafego de 7 dominios em prod, todos reversiveis em 1 PATCH)

## Resultado

**Todos 7 dominios do Grupo A migrados pro Cloudflare com sucesso.**

| Dominio | Status | Edge IP | Cache | Code |
|---|---|---|---|---|
| redirect.services | ✓ | 172.67.148.46 / 104.21.55.130 | DYNAMIC | 302 |
| redirect.wtf | ✓ | 172.67.148.17 / 104.21.71.186 | DYNAMIC | 302 |
| rechat.life | ✓ | 104.21.56.217 / 172.67.136.237 | DYNAMIC | 302 |
| rechat.live | ✓ | 104.21.15.190 / 172.67.163.201 | DYNAMIC | 302 |
| rechat.store | ✓ | 104.21.95.175 / 172.67.146.183 | DYNAMIC | 302 |
| redirect.belnk.in | ✓ | 104.21.90.252 / 172.67.206.100 | DYNAMIC | 302 |
| redirect.securitycop.ad | ✓ | 104.21.39.38 / 172.67.142.174 | DYNAMIC | 302 |

Trafego real ja chegando via CF (vi requests do FB IAB com IPs clientes reais nos logs nginx).

## Mudancas aplicadas

### 5 zonas APEX (config completa, igual redirect.plus)

Para cada zona — redirect.services, redirect.wtf, rechat.life, rechat.live, rechat.store:

| Setting | De | Para |
|---|---|---|
| browser_cache_ttl | 14400 | 0 |
| min_tls_version | 1.0 | 1.2 |
| ssl | full | strict |
| always_use_https | off | on |
| 0rtt | off | on |
| DNS A record proxied | false | **true** |

### 2 subdominios em zonas compartilhadas (apenas DNS)

Para `redirect.belnk.in` (parent: belnk.in) e `redirect.securitycop.ad` (parent: securitycop.ad):

- **APENAS** flipei o A record especifico pra `proxied=true`.
- **NAO** mexi em settings da zona pai.

**Razao**: as zonas pai tem OUTROS records ja proxied que nao estao no escopo desta task:
- `belnk.in`: tem `cdn.belnk.in` (108.179.193.124) e `www.belnk.in` (CNAME) ja proxied, mais `_domainconnect.belnk.in`.
- `securitycop.ad`: tem o apex (162.255.119.103, parking page Namecheap) e `www.securitycop.ad` ja proxied. Tambem tem `tag.securitycop.ad` em DNS-only — **nao toquei**.

Mexer em min_tls_version, ssl, 0rtt, browser_cache_ttl, always_use_https na zona pai poderia afetar esses outros servicos.

### Verificacao do "falso alarme"

Pode parecer que browser_cache_ttl=14400 herdado nas zonas pai cacharia o 302 no browser. **NAO acontece.** Verifiquei todos os 7 dominios: nenhum tem `Cache-Control` injetado pelo CF na resposta. Razao: `browser_cache_ttl` so se aplica a recursos que CF esta cacheando (status 2xx + Cache-Control da origem). Pra status DYNAMIC (302 sem Cache-Control da origem), CF passa direto sem tocar headers de cache.

## TTFB observado (5 amostras por dominio, do BR)

Variavel mas funcional. Faixa observada: 273ms (warm) a 1340ms (cold edge→origin).

Razao da variabilidade:
- Esses 7 dominios receberam keepalive pool fresh no momento da migracao.
- CF edge precisa estabelecer pool de conexoes TCP/TLS pra origin pra cada (zone, edge_pop) combinado.
- Com trafego real (RPS contínuo), o pool fica warm em minutos. Apos warm, TTFB converge pra ~280ms p50 igual redirect.plus.

Nao faz sentido medir percentil agora — 5 amostras com pool frio dao numeros enviesados.

## IP do cliente — confirmado funcionando

Apos o fix do nginx `cloudflare-real-ip.conf` (memoria anterior), o `req.ip` no Express agora esta correto pra TODOS os 7 dominios. Vi nos logs nginx em prod:
- `ip=31.167.140.181` (cliente real, broadcast FB)
- `ip=2401:4900:731d:ab18:...` (IPv6 cliente)
- `ip=2600:1700:1950:...` (cliente real)
- `ip=51.36.230.82` (cliente real)

Nao mais IPs CF edge (172.71.x.x, 104.22.x.x).

## Backup

`/Users/caionorder/Dev/redirect/scratchpad/cloudflare-backup/groupA_2026-05-08_HH-MM-SS/`

Contem para cada zona:
- `zone_<dominio>.json` — info completa
- `dns_<dominio>.json` — todos os DNS records anteriores (com proxied original)
- `settings_<dominio>.json` — snapshot de 12 settings antes da mudanca

## Rollback rapido

### Reverter UM dominio (volta DNS pra cinza):

Pegar `<dns_record_id>` do backup `dns_<dominio>.json`. Para os 5 apex:
- redirect.services: `81782a1a1f417b7e1aae5217b9a45bac` (zone `e33b5db378956d31e874e72db972cfea`)
- redirect.wtf: `b92e75fbbb118c8daf7699c41c5aa8cf` (zone `2ae4049ceacf14aa0f96c5b34ccc31dc`)
- rechat.life: `91eae6ce71bea30de3526035bff75dd0` (zone `80db63ccf951e5b5b77e7e5fb77f28c1`)
- rechat.live: `8480a55e990b6947710e29e76f0ee744` (zone `f9d59c77c40d43c076bc7fced345fa68`)
- rechat.store: `ffc30af9e23b9ac1ace661b8c2762cd3` (zone `acabced2894c138e622862760d8f40e2`)
- redirect.belnk.in: `6d17e863d2df94ff983444de77859c14` (zone `11cf4f59c604511c4af99a7ac5abed73`)
- redirect.securitycop.ad: `10eaeb7b4385e786665694937401d288` (zone `a12575bb8ba781b41d9281315816d303`)

```bash
curl -sS -X PATCH \\
  "https://api.cloudflare.com/client/v4/zones/<zone_id>/dns_records/<record_id>" \\
  -H "X-Auth-Email: caio@caionorder.com" \\
  -H "X-Auth-Key: <KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"proxied": false}'
```

### Reverter settings de uma zona apex:

```bash
# exemplo: rechat.life browser_cache_ttl
curl -sS -X PATCH \\
  "https://api.cloudflare.com/client/v4/zones/80db63ccf951e5b5b77e7e5fb77f28c1/settings/browser_cache_ttl" \\
  -H "X-Auth-Email: caio@caionorder.com" \\
  -H "X-Auth-Key: <KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"value":14400}'
```

Repetir pra cada (setting, valor original) listado no `settings_<dominio>.json`.

## Status atual da migracao redirect → CF

| Status | Count | Dominios |
|---|---|---|
| ✓ Migrado | **8** | redirect.plus, redirect.services, redirect.wtf, rechat.life, rechat.live, rechat.store, redirect.belnk.in, redirect.securitycop.ad |
| Pendente — precisa mover NS do Namecheap pro CF | 8 | perfil.im, perfil.best, perfil.biz, perfil.buzz, meeting.boats, meeting.beauty, meetings.beauty, meetings.click |

## Proximos passos

1. **Monitorar 24-48h** — `/var/log/nginx/redirect.access-perf.log` pra confirmar 302 e nenhum 526/525.
2. **Para os 8 do Grupo B**: user vai apontar NS pro CF (operacao no Namecheap). Quando terminar, eu rodo a mesma checklist (criar zona via API ou apos zona ficar `active` no CF, aplicar 6 mudancas).
3. **Acao de seguranca**: rotacionar a Global API Key (ja avisado anteriormente). Migrar pra API Token escopado.

## Arquivos gerados

- `scratchpad/agent-hephaestus-cf-groupA.md` — este relatorio
- `scratchpad/cloudflare-backup/groupA_*/...` — backups completos das 7 zonas
- `/tmp/cf-backup.sh`, `/tmp/cf-migrate-apex.sh` — scripts usados (efemeros, podem ser deletados)
