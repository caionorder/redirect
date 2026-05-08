Voce e Hephaestus, sysadmin-engineer. Modo: APLICAR mudancas em nginx.conf. Nao recarregar nginx (so editar arquivo). Nao commitar. Nao deploy.

## Contexto
Projeto: /Users/caionorder/Dev/redirect. Arquivo alvo: /Users/caionorder/Dev/redirect/nginx.conf. Sua analise esta em scratchpad/agent-hephaestus.md.

Voce vai aplicar SOMENTE as mudancas Fase 1 itens 1.1, 1.2, 1.3 do plano `scratchpad/PERFORMANCE_PLAN.md`. NAO mexa em Dockerfile nem Jenkinsfile (Fase 2).

## Mudancas

### 1.1 — error_log debug → warn
Linha atual (linha ~6): `error_log /var/log/nginx/redirect.error.log debug;`
Trocar para: `error_log /var/log/nginx/redirect.error.log warn;`

### 1.2 — Upstream keepalive + HTTP/2 + Connection vazio
**Adicionar upstream block** ANTES do `server { ... }` (no top do arquivo, antes do primeiro `server`):
```nginx
upstream redirect_backend {
    server 127.0.0.1:6969;
    keepalive 64;
    keepalive_requests 10000;
    keepalive_timeout 60s;
}
```

**No location /** dentro do server block 443:
- Trocar `proxy_pass http://127.0.0.1:6969$request_uri;` por `proxy_pass http://redirect_backend;` (sem `$request_uri`).
- Garantir `proxy_http_version 1.1;` (ja existe, manter).
- Trocar `proxy_set_header Connection 'upgrade';` por `proxy_set_header Connection "";` (NUNCA upgrade — esse header forcava nao-reuso).
- REMOVER `proxy_set_header Upgrade $http_upgrade;` se existir (so faz sentido em rotas WebSocket especificas — neste servico nao tem WS).
- REMOVER `proxy_cache_bypass $http_upgrade;` se existir (so faz sentido com proxy_cache configurado, que nao tem aqui).

**No listen 443 ssl;** (linha ~54): trocar para `listen 443 ssl http2;`. Manter o resto (`# managed by Certbot`).

### 1.3 — Otimizacoes adicionais
- Trocar `keepalive_requests 100;` (linha ~10) por `keepalive_requests 1000;`
- Trocar `gzip_min_length 10;` (linha ~46) por `gzip_min_length 1024;`
- Trocar `access_log /var/log/nginx/redirect.access.log;` (linha ~5) por `access_log /var/log/nginx/redirect.access.log buffer=64k flush=5s;` (formato default — nao tem `main` definido aqui, entao usa default `combined`)
- Remover `proxy_buffers 8 16k;` (linha ~37) — codigo morto pq `proxy_buffering off` esta setado. Manter `proxy_buffer_size 32k;` (esse ainda controla buffer da resposta inicial mesmo com buffering off).

### Mudancas que NAO faz parte (NAO aplicar agora):
- Rate limiting nginx (Fase 4)
- TLS hardening adicional (Fase 1.7 do report do Hephaestus, mas NAO no plano consolidado Fase 1 — pular)
- Server HTTP wildcard 404 → 301 (Fase decisao produto)

## Restricoes
- Editar APENAS /Users/caionorder/Dev/redirect/nginx.conf
- NAO rodar `nginx -t`, `nginx -s reload`, ou qualquer comando contra nginx do host
- NAO commit
- Confirmar com Read+grep antes de editar (linhas podem ter shift)

## Risco
LOW. Nginx config e isolada. Mudanca de `Connection ""` requer que upstream Node aceite keepalive (Node default aceita).

## Entregavel
`scratchpad/agent-hephaestus-impl.md` com:
- Diff conceitual do nginx.conf antes/depois
- Comando recomendado para o usuario validar (`nginx -t -c <path>` no servidor de prod)
- Riscos / rollback plan (manter copia do antigo em nginx.conf.bak ANTES de editar — faca isso primeiro)

## Memoria Obsidian
Crie:
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-08_09-35_perf-impl-hephaestus.md

## Passo final OBRIGATORIO
Apos aplicar, rode EXATAMENTE:
cmux wait-for --signal done-hephaestus-impl-1730983800
