# Hephaestus — Incidente migracao Grupo B (Cloudflare)

Data: 2026-05-08 ~16:37-16:42 BRT
Persona: Hephaestus (sysadmin-engineer)
Severidade: **MEDIA** — janela de ~4min com HTTPS quebrado em 7 dominios. Mitigado por rollback automatico.
Estado atual: **RESTAURADO**, tudo via origin. Pendente reproxiar quando cert CF ficar `active`.

## TL;DR

Migrei os 7 dominios do Grupo B (perfil.im, perfil.best, perfil.biz, perfil.buzz, meeting.boats, meeting.beauty, meetings.beauty) pro CF aplicando settings + proxiando. **Universal SSL do CF ainda estava `initializing`** (nao terminou de provisionar pra zonas recem-ativadas). Sem cert, o CF rejeitava todo handshake HTTPS com `tls alert 40 (handshake_failure)`.

Quando detectei (curl validation), **desproxiei imediatamente as 7 zonas** + desliguei `always_use_https`. Trafego voltou a fluir 100% via origin com cert nginx Let's Encrypt.

Janela de degradacao: ~4 minutos (16:37 → 16:42 BRT).

## Cronologia

| Hora (BRT) | Acao | Estado |
|---|---|---|
| 16:37:38 | Apliquei `proxied=true` + 5 settings nas 7 zonas | DNS propagou em segundos |
| 16:37:43 | Curl validation iniciou | Todos retornaram `tls handshake failure` |
| 16:38-41 | Investigacao (verbose TLS, openssl s_client, SSL verification API) | Confirmado: cert universal CF `initializing` |
| 16:41:51 | **Rollback**: `proxied=false` + `always_use_https=off` em todas as 7 | API confirmou success |
| 16:42-44 | Verificacao DNS/origin | Tudo OK via origin com Let's Encrypt |

## Causa raiz

Universal SSL do Cloudflare leva 5min-24h pra ser emitido pra uma zona recem-adicionada. O ciclo eh:
1. Zona criada e NS apontados → status=`pending`
2. CF detecta NS → status=`active`
3. CF inicia provisioning Universal SSL → cert_status=`initializing`
4. Cert emitido + propagado pra edge → cert_status=`active`

Eu apliquei `proxied=true` enquanto cert estava `initializing`. CF roteou o trafego pra edge mas nao tinha cert valido pra apresentar ao client (SNI=perfil.im). Resposta: `tls alert 40`.

**Eu deveria ter checado `cert_status` ANTES de proxiar.** Ja tinha visto o sinal: `dig @1.1.1.1 NS perfil.biz` retornou Namecheap, sugerindo NS recem-mudados.

## Aprendizado / regra pra proximas migracoes

**Pre-flight check obrigatorio antes de proxiar uma zona Group-B-style** (zona recem-movida pra CF):

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZID/ssl/verification" \
  -H "X-Auth-Email: ..." -H "X-Auth-Key: ..." | jq '.result[].certificate_status'
```

Se for `initializing` ou diferente de `active`, **NAO PROXIAR**. Esperar.

## Estado atual (17:00 BRT)

### DNS
Os 7 dominios voltam a apontar pra `64.23.139.53` (origin direta). DNS publico (1.1.1.1, 8.8.8.8, 9.9.9.9 e os 2 NS CF) confirma. Meu cache local DNS demorou pra propagar mas isso nao afeta producao.

### Settings nas 7 zonas (Group B)
- `browser_cache_ttl=0` ✓ (mantido)
- `min_tls_version=1.2` ✓ (mantido)
- `ssl=strict` ✓ (mantido)
- `always_use_https=off` ⚠ **DESLIGADO temporariamente** (era on; voltar quando reproxiar)
- `0rtt=on` ✓ (mantido)
- `proxied` ⚠ **false** (rollback do incidente)

### Trafego de producao
Confirmei via `tail` do `redirect.access-perf.log`: trafego real do FB IAB chegando em `host=perfil.buzz`, `meeting.beauty`, `meetings.click`, `perfil.best` etc. com IPs clientes reais (BR, India, Marrocos). **rt=0.003-0.013s normal**.

### Cert status (verificado 17:00 BRT)
| Dominio | cert_status |
|---|---|
| perfil.im | initializing |
| perfil.best | initializing |
| perfil.biz | initializing |
| perfil.buzz | initializing |
| meeting.boats | initializing |
| meeting.beauty | initializing |
| meetings.beauty | initializing |

Cada zona tem 2 cert packs: 1 `initializing` (o que esta sendo emitido) e 1 `backup_issued` (cert standby). CF ainda nao decidiu promover o backup pra active — comportamento normal pra zonas recem-ativadas.

## Acao pendente — reproxiar quando cert ficar `active`

Quando `cert_status=active` em todas as 7 zonas (provavelmente 30min-2h dali da migracao inicial, talvez mais), executar:

```bash
# Re-aplicar always_use_https=on
for ZID in 88fdfbf2728c349b8ca1f9024ac427ae 71f73d0a1c82855460112a53a784d18c efb6f7f9f53062dea0a239b1f644cd33 fc7bbb99295e7c59415ca8e62b16ad76 6b8968b526a63aab24a1dc678e9a4d19 e62f61f4c25c6b084211428eed401709 bb6973568538d5824910037f26fab3d8; do
  curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZID/settings/always_use_https" \
    -H "X-Auth-Email: caio@caionorder.com" \
    -H "X-Auth-Key: $CF_KEY" \
    -H "Content-Type: application/json" \
    -d '{"value":"on"}'
done

# Re-proxiar (NAMES e RIDS arrays definidos em /tmp/cf-emergency-unproxy.sh)
bash -c '
NAMES=(perfil.im perfil.best perfil.biz perfil.buzz meeting.boats meeting.beauty meetings.beauty)
ZIDS=(88fdfbf2728c349b8ca1f9024ac427ae 71f73d0a1c82855460112a53a784d18c efb6f7f9f53062dea0a239b1f644cd33 fc7bbb99295e7c59415ca8e62b16ad76 6b8968b526a63aab24a1dc678e9a4d19 e62f61f4c25c6b084211428eed401709 bb6973568538d5824910037f26fab3d8)
RIDS=(35e67303c7590e78eee6edbee221479b 20ff7627e6cdc243a0d770c21e6a8e2f 05b577f27e02d81dc1b13b6e0b2950d3 ccfbe5b592108f4e093454ce3d0c2bf0 b1825be4880630d375962c7d23b07df8 647b54b38844b7dce09321be1014c15c 5404d07751be4cdfa718019ed2558179)
for i in "${!NAMES[@]}"; do
  curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/${ZIDS[$i]}/dns_records/${RIDS[$i]}" \
    -H "X-Auth-Email: caio@caionorder.com" \
    -H "X-Auth-Key: $CF_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"proxied\": true}"
done
'
```

## meetings.click — ainda em `pending`

Zona oitava do Grupo B. Status=`pending` no CF (NS nao detectados ainda pelo CF do lado autoritativo). Preciso aguardar CF promover pra `active`, depois aplicar settings + proxiar.

NS do Namecheap ja mudaram (pra aragorn.ns.cloudflare.com / haley.ns.cloudflare.com), mas CF demora pra confirmar via verificacao automatica. Pode ser questao de horas.

## Resumo total da migracao redirect → CF

| Status | Count | Dominios |
|---|---|---|
| ✓ Migrado e funcionando | **8** | redirect.plus, redirect.services, redirect.wtf, rechat.life, rechat.live, rechat.store, redirect.belnk.in, redirect.securitycop.ad |
| ⏳ Aguardando cert active | **7** | perfil.im, perfil.best, perfil.biz, perfil.buzz, meeting.boats, meeting.beauty, meetings.beauty |
| ⏳ Aguardando zona ficar active | **1** | meetings.click |

## Backups

`/Users/caionorder/Dev/redirect/scratchpad/cloudflare-backup/groupB_2026-05-08_16-37-38/` — settings/dns/zone snapshot pre-migracao.

## Scripts criados (uteis)

- `/tmp/cf-backup.sh` — snapshot zona+dns+settings
- `/tmp/cf-inspect-groupB.sh` — listar dns records das 7 zonas
- `/tmp/cf-migrate-groupB.sh` — aplicar 5 settings + proxy nas 7
- `/tmp/cf-emergency-unproxy.sh` — rollback rapido (proxied=false + always_use_https=off)
- `/tmp/cf-ssl-status.sh` — checar cert status

## Acao recomendada

Voce tem 2 opcoes:

1. **Me chamar daqui ~30-60min** com algo tipo "Hephaestus, reproxia o Grupo B" — eu rodo o cf-ssl-status.sh, se todos `active`, executo o reproxy. Tempo: 30s.
2. **Eu programar polling automatico** — uso `ScheduleWakeup` pra acordar a cada 15min ate cert ficar pronto. Mais hands-off mas usa mais ciclos meus.

Recomendo opcao 1.
