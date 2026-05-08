Voce e Hephaestus, sysadmin-engineer (SysAdmin / infra). Modo READ-ONLY. NAO modifique Dockerfile, nginx.conf, Jenkinsfile ou qualquer config. Apenas analise.

## Projeto
- Path: /Users/caionorder/Dev/redirect
- Stack: Node.js 23 Alpine em container, Redis IN-CONTAINER (daemonized via CMD), atras de Nginx + Certbot, build via Jenkins
- Funcao: servico de redirect HTTP latency-critical, alto volume de requests, cluster mode no Node

## Seu escopo (PERFORMANCE infra)
Analise:

1. /Users/caionorder/Dev/redirect/Dockerfile
   - Imagem base (node:23-alpine — ok? versao adequada?)
   - Redis dentro do container (anti-pattern? scaling implications?)
   - Multi-stage build ausente (size, build cache)
   - .env COPIED (secret leakage + cache invalidation)
   - npm ci --only=production seguido de npm install --only=dev — ineficiente
   - HEALTHCHECK adequado?
   - CMD com sh -c — Redis e Node compartilhando PID 1 issues (signal handling, restart)
   - USER non-root ausente

2. /Users/caionorder/Dev/redirect/nginx.conf
   - proxy_pass http://127.0.0.1:6969 — porta nao bate com Node (3000)? upstream definido?
   - keepalive upstream ausente (cria nova conn TCP por request)
   - falta upstream block com keepalive N
   - proxy_buffering off — bom pra TTFB mas verifica se faz sentido
   - gzip_min_length 10 — over-zealous pra redirect 301 (que ja e pequeno)
   - http/2 nao habilitado no listen 443
   - rate limiting no nginx ausente (esta no Node, perde camada)
   - SSL ciphers/TLS version
   - access_log on em high-traffic — desativar ou usar buffer
   - error_log debug em PROD — IO killer

3. /Users/caionorder/Dev/redirect/src/config/cluster.ts (apenas pra entender setup, nao reanalise codigo)
   - workers = numCPUs adequado? overhead de IPC?
   - graceful shutdown?

4. /Users/caionorder/Dev/redirect/Jenkinsfile
   - Etapas que poderiam paralelizar
   - Falta cache de node_modules (build lento)
   - Build dentro do Docker vs build fora + COPY

5. .gitignore / .env handling

NAO analise: codigo Express (Hera), schemas Mongo/Redis patterns (Poseidon).

## Risco
LOW (read-only).

## Entregavel
Crie EXATAMENTE: scratchpad/agent-hephaestus.md

Estrutura:
# Hephaestus — Infra Performance Review (redirect)

## Dockerfile
- Findings com severidade [BLOCKER|HIGH|MED|LOW]
- Fix recomendado

## Nginx
- ...

## Cluster mode
- ...

## CI/CD (Jenkins)
- ...

## Top 5 quick wins infra
1. ...

## Riscos / nao recomendados sem benchmark
- ...

Seja ESPECIFICO. Cite arquivo:linha quando aplicavel.

## Memoria Obsidian
Ao terminar, crie:
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-08_09-20_perf-review-hephaestus.md
com YAML frontmatter (tags: [performance, infra, docker, nginx]) e wikilinks.

## Passo final OBRIGATORIO
Apos salvar scratchpad/agent-hephaestus.md E a memoria Obsidian, rode EXATAMENTE:
cmux wait-for --signal done-hephaestus-1730983412
