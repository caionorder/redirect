---
agent: Hephaestus (sysadmin-engineer)
task: Aplicar HSTS no nginx (fix M1 do Aegis review)
date: 2026-05-08
risk: LOW
files_touched:
  - nginx.conf
---

# Hephaestus — HSTS fix (Aegis M1)

## Contexto

Aegis review (`scratchpad/agent-aegis-review.md`) flagou M1: HSTS removido do hot path quando helmet foi movido pro escopo `/api`. Solucao escolhida: setar HSTS no nginx — uma linha cobre TODAS as responses (302s do hot path, JSON do `/api`, errors 4xx/5xx via flag `always`).

## Mudanca aplicada

### Arquivo
`/Users/caionorder/Dev/redirect/nginx.conf`

### Linha exata adicionada
```nginx
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

### Posicionamento (apos a edicao)
- **Linha 28** do `nginx.conf`
- Logo apos `open_file_cache_errors on;` (linha 26)
- Antes do bloco `location /` (linha 31)
- Dentro do `server { ... listen 443 ssl http2; ... }` — escopo correto, herda em todos os locations

### Decisoes
- `max-age=31536000` (1 ano) — padrao de mercado, alinhado com config helmet anterior
- `includeSubDomains` — cobre `redirect.belnk.in` e qualquer subdominio que venha a ser servido pelo mesmo host
- **NAO incluido `preload`** — submeter pra lista preload da Mozilla e decisao explicita do time, nao deve ser default
- `always` — garante envio do header em respostas 4xx/5xx (importante: redirects 302 do hot path nao sao "errors", mas o flag tambem cobre o caso futuro de 404/500 do Node)

## Diff conceitual

```diff
     open_file_cache_errors on;

+    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
+
     # CORREÇÃO PRINCIPAL: Captura o path e adiciona ao prefixo
     location / {
```

## Validacao recomendada (no servidor, fora desta task)

1. **Sintaxe**:
   ```bash
   sudo nginx -t
   ```
   Deve retornar `syntax is ok` e `test is successful`.

2. **Reload sem downtime**:
   ```bash
   sudo systemctl reload nginx
   ```

3. **Verificar header em response real**:
   ```bash
   # Hot path (302):
   curl -sI https://redirect.belnk.in/algum-slug | grep -i strict-transport
   # Esperado: Strict-Transport-Security: max-age=31536000; includeSubDomains

   # API (JSON):
   curl -sI https://redirect.belnk.in/api/health | grep -i strict-transport
   # Esperado: mesma linha

   # Error path (404 fabricado):
   curl -sI https://redirect.belnk.in/__definitivamente-nao-existe | grep -i strict-transport
   # Esperado: header presente (graças ao 'always')
   ```

4. **Testar via SSL Labs / securityheaders.com** apos reload — esperar grade A em HSTS.

## Riscos / pontos de atencao

- **Browsers que ja receberam HSTS** via helmet anteriormente: ja estao protegidos, nada muda
- **Primeira visita** (browser sem cache HSTS): agora ganha protecao mesmo no hot path 302 (regressao do Aegis M1 fechada)
- **Reverter**: simples — comentar a linha e reload. Browser cache de HSTS ainda vai persistir pelo `max-age` configurado, mas nao ha downside nisso
- **Nao mexi** em Dockerfile, Jenkinsfile, helmet config, ou app code

## Estado atual

- [x] Linha aplicada em `nginx.conf`
- [x] Read pos-edit confirmado (estado em contexto)
- [ ] **NAO** rodei `nginx -t` (instrucao explicita)
- [ ] **NAO** rodei reload (instrucao explicita)
- [ ] **NAO** commit (instrucao explicita)

## Proximos passos (para o time)

1. Quem for promover pra prod: rodar `nginx -t` no servidor antes do reload
2. Apos reload, validar com `curl -I` nos 3 paths (302, JSON, 404)
3. Considerar adicionar `preload` numa task futura, apos:
   - Confirmar que TODOS os subdominios `*.belnk.in` servem HTTPS
   - Time decidir submeter pra lista preload da Mozilla (decisao irreversivel por ~6 meses)
