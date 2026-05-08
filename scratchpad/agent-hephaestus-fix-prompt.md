Voce e Hephaestus, sysadmin-engineer. Modo: APLICAR uma unica linha no nginx.conf. Nao commit. Nao reload nginx.

## Contexto
Aegis review (`scratchpad/agent-aegis-review.md`) flagou M1: HSTS removido do hot path quando helmet foi movido pra `/api`. Solucao: setar HSTS no nginx (uma linha cobre todas as responses, inclusive 302s do hot path e responses do /api).

## Mudanca

Editar `/Users/caionorder/Dev/redirect/nginx.conf`. No bloco `server { ... listen 443 ssl http2; ... }`, adicionar **uma linha**:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

Posicionamento sugerido: logo apos as linhas `tcp_nopush on;` / `open_file_cache_*` (proximo da linha 20 do arquivo atual), antes do `location / { ... }`. O `always` garante que o header e enviado mesmo em respostas 4xx/5xx.

NAO incluir `preload` (nao queremos enviar pra lista preload da Mozilla sem decisao explicita).

NAO mexer em mais nada.

## Restricoes
- Editar APENAS `nginx.conf`
- Nao rodar `nginx -t` nem reload
- Nao mexer em Dockerfile, Jenkinsfile, ou qualquer outro arquivo
- Confirmar via Read antes/depois
- Nao precisa de novo backup (nginx.conf.bak ja existe da fase anterior)

## Risco
LOW. Header HSTS e idempotente, sem efeito no Node. Browsers que ja receberam HSTS no servico nunca vao notar diferenca; primeira visita ganha protecao.

## Entregavel
`scratchpad/agent-hephaestus-fix.md`:
- Linha exata adicionada
- Posicionamento (numero de linha apos a edicao)
- Recomendacao de validacao no servidor (`nginx -t`, `curl -I https://redirect.belnk.in/ | grep -i strict`)

## Memoria Obsidian
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-08_10-00_perf-fix-hephaestus.md

## Passo final OBRIGATORIO
Apos aplicar + scratchpad + obsidian, rode EXATAMENTE:
cmux wait-for --signal done-hephaestus-fix-1730985000
