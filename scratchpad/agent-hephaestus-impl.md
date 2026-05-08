# Hephaestus — Impl Fase 1 (1.1, 1.2, 1.3) — nginx.conf

Data: 2026-05-08
Escopo: aplicar mudanças de Fase 1 itens 1.1, 1.2, 1.3 do `scratchpad/PERFORMANCE_PLAN.md` em `/Users/caionorder/Dev/redirect/nginx.conf`.

Backup criado em `nginx.conf.bak` ANTES de qualquer edição.

---

## Diff conceitual antes/depois

### 1.1 — error_log debug → warn
- **Antes** (linha 6): `error_log /var/log/nginx/redirect.error.log debug;`
- **Depois** (linha 13): `error_log /var/log/nginx/redirect.error.log warn;`
- **Por quê**: `debug` força fsync síncrono no hot path; em RPS alto vira gargalo de IO.

### 1.2 — Upstream keepalive + HTTP/2 + Connection vazio
**Adicionado bloco upstream antes do `server { ... }`** (linhas 1–6 do arquivo final):
```nginx
upstream redirect_backend {
    server 127.0.0.1:6969;
    keepalive 64;
    keepalive_requests 10000;
    keepalive_timeout 60s;
}
```

**Mudanças no `location /`** (linhas 29–44):
| Antes | Depois |
|-------|--------|
| `proxy_pass http://127.0.0.1:6969$request_uri;` | `proxy_pass http://redirect_backend;` |
| `proxy_set_header Upgrade $http_upgrade;` | _(removido)_ |
| `proxy_set_header Connection 'upgrade';` | `proxy_set_header Connection "";` |
| `proxy_cache_bypass $http_upgrade;` | _(removido)_ |
| `proxy_buffers 8 16k;` | _(removido — código morto, `proxy_buffering off`)_ |

**listen 443**:
- **Antes** (linha 54): `listen 443 ssl; # managed by Certbot`
- **Depois** (linha 56): `listen 443 ssl http2; # managed by Certbot`

**Por quê (efeito esperado)**:
- `Connection ""` (vazio) habilita HTTP keepalive entre nginx e Node — sem isso, `'upgrade'` força nova conexão TCP por request, esgotando portas efêmeras (TIME_WAIT). É o ganho mais relevante deste round.
- `keepalive 64` no upstream mantém pool de conexões reutilizáveis com Node; `keepalive_requests 10000` evita reciclagem prematura.
- HTTP/2 (`http2` no listen) reduz handshakes para clientes modernos (multiplexação, header compression).
- Removidos `Upgrade`, `Connection 'upgrade'`, `proxy_cache_bypass $http_upgrade` — só fazem sentido em rotas WebSocket; este serviço não tem WS.
- `proxy_buffers 8 16k` é ignorado quando `proxy_buffering off`. `proxy_buffer_size 32k` mantido pois ainda controla buffer da resposta inicial (status + headers).

### 1.3 — Otimizações adicionais
| Mudança | Antes | Depois |
|---------|-------|--------|
| keepalive_requests do server | `100` (linha 10) | `1000` (linha 17) |
| gzip_min_length | `10` (linha 46) | `1024` (linha 48) |
| access_log | `... redirect.access.log;` (linha 5) | `... redirect.access.log buffer=64k flush=5s;` (linha 12) |

**Por quê**:
- `keepalive_requests 1000`: 100 era reciclagem agressiva (cliente reconecta a cada 100 reqs).
- `gzip_min_length 1024`: gzip em 301/302 (que retornam ~200 bytes de body ou nenhum) é puro custo de CPU sem benefício.
- `access_log buffer=64k flush=5s`: agrega writes em batches em vez de syscall por request. Mantém o formato default (`combined`) — não tem `log_format main` definido neste arquivo.

---

## Comando recomendado para validar

No servidor de produção (NÃO foi rodado neste host — é arquivo dev):

```bash
# 1) Validar sintaxe sem aplicar
sudo nginx -t

# 2) Ver diff entre nginx.conf instalado e este arquivo
diff /etc/nginx/sites-available/redirect /caminho/para/nginx.conf

# 3) Aplicar (so se nginx -t passou)
sudo nginx -s reload
```

**Importante**: `nginx -t` precisa que os caminhos do certbot existam (`/etc/letsencrypt/live/...`). No dev local provavelmente vai falhar — validar só em staging/prod.

---

## Riscos / rollback

### Riscos
1. **Connection "" exige Node aceitar keepalive** — Node default (Express + http.Server) aceita; mas se `server.keepAliveTimeout` no Node estiver MENOR que `keepalive_timeout 60s` aqui, vai dar `502 Bad Gateway` esporádico (race entre Node fechar a conexão e nginx tentar reusar).
   - **Mitigação**: confirmar `server.keepAliveTimeout = 65000` (>60s) no `app.ts`. Athena pode validar isso no PR dela de Fase 1.4-1.5.
2. **HTTP/2 (`http2` no listen)** — clientes muito antigos (HTTP/1.0 only) seguem caindo no fallback ssl, sem regressão. Requer `nginx >= 1.9.5` (qualquer versão produção atual já tem).
3. **`gzip_min_length 1024`** — corpos pequenos param de ser comprimidos. Se algum endpoint retorna JSON 200–1024 bytes muito chamado, perde compressão (ganho deles era marginal mesmo).

### Rollback
Backup intacto em `/Users/caionorder/Dev/redirect/nginx.conf.bak`.
```bash
cp /Users/caionorder/Dev/redirect/nginx.conf.bak /Users/caionorder/Dev/redirect/nginx.conf
```
No servidor de prod, mesmo padrão: backup antes do deploy, `cp .bak` em cima se algo regredir após `nginx -s reload`.

---

## Checklist de aplicação

- [x] Backup `nginx.conf.bak` criado
- [x] 1.1 error_log debug → warn
- [x] 1.2 upstream redirect_backend block adicionado
- [x] 1.2 proxy_pass apontando para upstream nomeado
- [x] 1.2 Connection "" (vazio), Upgrade/proxy_cache_bypass removidos
- [x] 1.2 listen 443 ssl http2
- [x] 1.3 keepalive_requests 1000
- [x] 1.3 gzip_min_length 1024
- [x] 1.3 access_log buffer=64k flush=5s
- [x] 1.3 proxy_buffers 8 16k removido (dead code)
- [ ] `nginx -t` em staging/prod (pendente — usuário roda)
- [ ] `nginx -s reload` em prod (pendente — usuário aplica)

---

## Fora de escopo (NÃO aplicado)

- Fase 2 (Dockerfile multi-stage, tirar Redis do container, Jenkinsfile)
- Fase 4.6 (rate limiting nginx)
- TLS hardening adicional (não estava no plano consolidado Fase 1)
- Servidor HTTP wildcard 404 → 301 (decisão produto)

---

## Arquivos tocados

- `nginx.conf` — modificado
- `nginx.conf.bak` — criado (backup pré-edit)
- `scratchpad/agent-hephaestus-impl.md` — este arquivo
