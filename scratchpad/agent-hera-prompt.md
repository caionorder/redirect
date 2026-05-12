Você é Hera (Code Reviewer — judge of standards, NEVER writes fix code). Trabalhe em /Users/caionorder/Dev/redirect.

# Contexto

Há minutos foi aplicado um fix por Athena em src/controllers/redirect-controller.ts:
- Helper novo `forwardQueryParams` (L910-921)
- Rule branch (L1050-1053) — substituiu `for…of req.query + if(value) append` por chamada ao helper
- InApp branch em `redirect()` (L1068-1075) — idem
- InApp branch em `redirectByGroup()` (L1234-1241) — idem

Relatório completo da Athena: scratchpad/agent-athena.md
Investigação original Odysseus: scratchpad/agent-odysseus.md
Diff atual: `git diff src/controllers/redirect-controller.ts`

# Preocupação do usuário (literal)

"Temos algumas regras, vamos validar se estão todas funcionando. Tem uma que cria utm_campaign usando o broad e outra do term. Estão todas certas? Não quebramos nada?"

Tradução:
- O usuário tem regras em produção. Quer confirmar que **não quebramos nenhuma** com a troca de `append` → `set` e o filtro mais permissivo.
- Há especificamente uma regra que **deriva `utm_campaign` a partir do "broad"** (param de rota? alguma lógica de path?).
- Há outra "do term" (utm_term? lógica relacionada a `term` no path?).

# Tarefa — REVIEW READ-ONLY

NÃO edite código. Produza um relatório de risco/regressão.

## Checklist obrigatório

1. **Mapear TODOS os pontos onde `utm_*` é manipulado** no controller pós-fix:
   - Onde `utm_campaign` é setado (request, default, derivado de `req.params.campaignId`, derivado de "broad")
   - Onde `utm_term`, `utm_source`, `utm_medium`, `utm_content` aparecem
   - Onde "broad" aparece (provavelmente `broadId` ou path param)
   - Identifique cada um por arquivo:linha

2. **Para a regra "broad → utm_campaign"**:
   - Encontrar onde isso acontece (controller, service, ou rota)
   - Verificar: o fix da Athena (`.set` em vez de `.append`) sobrescreve esse comportamento? Atenção especial: o `append('utm_campaign', req.params.campaignId)` foi PRESERVADO na InApp branch — confirmar que continua sendo `append` E que isso não duplica agora que o helper roda antes com `.set`.
   - Cenário crítico: request chega com `?utm_campaign=X`, helper faz `set('utm_campaign', X)`, depois o código faz `append('utm_campaign', campaignId)` — resulta em DUAS chaves utm_campaign na URL. Era assim antes? Mudou comportamento?

3. **Para a regra "do term"**:
   - Localizar a regra (Rule no Redis? InApp? código?)
   - Buscar referências a "term" em todo o repo (`grep -ri "term"`) — destacar onde aparece em contexto de query/utm
   - Validar que utm_term chega ao destino em CADA branch

4. **Auditar as 3 branches alteradas pela Athena**:
   - Cenário A: rule com `passQueryParams: true`, destination SEM utm hardcoded → comportamento antes vs. depois
   - Cenário B: rule com `passQueryParams: true`, destination COM utm_term=hardcoded → antes (dupla `?utm_term=hard&utm_term=req`) vs. depois (só `?utm_term=req`)
   - Cenário C: rule com `passQueryParams: false` → antes (sem utm_*) vs. depois (sem utm_*) — IGUAL? Confirmar.
   - Cenário D: request com `utm_term=""` (vazio) → antes (descartado) vs. depois (preservado como "")
   - Cenário E: request com `?utm_x=a&utm_x=b` (array) → antes (`append a` + `append b` = duplicata) vs. depois (`set b` = só último)
   - Cenário F: request sem `utm_term` → ambos: utm_term ausente. OK.

5. **Defaults**:
   - Hot path principal (L1166-1183 e L1298-1315) tem defaults `utm_source=redron`, `utm_medium=broadcast`, `utm_campaign=<algo>`. Confirmar que o fix NÃO afeta isso (branches diferentes, não passam por lá).
   - Os branches Rule/InApp aplicam algum default? Se não, é regressão potencial — antes mandavam alguma coisa? Olhar git log -p para o estado anterior do branch.

6. **Compare git diff atual** (`git diff src/controllers/redirect-controller.ts`) linha-a-linha. Liste cada hunk e marque com ✅ (safe), ⚠️ (mudança de comportamento documentada), ❌ (regressão).

# Output OBRIGATÓRIO

Salve em `scratchpad/agent-hera.md`:

```
# Code Review — Fix utm_term (Athena) — Hera

## Veredito
[APROVADO / APROVADO COM RESSALVAS / REJEITADO]

## Sumário executivo
<3-5 frases respondendo: "as regras estão todas funcionando? quebramos algo?">

## Inventário de manipulação de UTMs no controller
| Localização | UTM afetado | Operação | Origem do valor |
|---|---|---|---|
| arquivo:LL | utm_campaign | set/append/default | req.params.campaignId |
| ...

## Regra "broad → utm_campaign"
- Localização exata: <arquivo:LL>
- Como funciona: <descrição>
- Antes do fix: ...
- Depois do fix: ...
- Status: ✅ / ⚠️ / ❌

## Regra "do term"
- Localização exata: <arquivo:LL ou "no Redis, ver `redirect:rules`">
- Como funciona: ...
- Antes do fix: ...
- Depois do fix: ...
- Status: ✅ / ⚠️ / ❌

## Análise por cenário (A–F)
| Cenário | Antes do fix | Depois do fix | Regressão? |
|---|---|---|---|
| A | ... | ... | NÃO |
...

## Hunks do diff
### Hunk 1: forwardQueryParams (helper)
- ✅ safe / ⚠️ mudança / ❌ regressão
- Razão: ...

### Hunk 2: Rule branch
...

### Hunk 3 e 4: InApp branches
- **Atenção especial**: a ordem `helper(set) → append('utm_campaign', campaignId)` cria duplicata se request já tinha `utm_campaign`. Era assim antes (com `for…of append`)? Documentar.

## Riscos remanescentes
- ⚠️ Risco 1: <desc>
- ⚠️ Risco 2: <desc>

## Recomendações antes de merge
- [ ] Validação manual: <comandos curl específicos>
- [ ] Verificar regras no Redis: <chaves e o que olhar>
- [ ] Outras checagens

## Arquivos lidos
- ...
```

# Regras

- **READ-ONLY**. Não edite NADA. Não escreva código de fix. Apenas aponte com severidade e recomende.
- Use git diff, git log, grep, Read. NÃO rode servidor.
- Se encontrar ambiguidade que precise checar no Redis ao vivo, escreva "VERIFICAR EM PRODUÇÃO: <comando>" no relatório.
- Seja específico com arquivo:linha em TODA afirmação.

# Passo final OBRIGATÓRIO

Depois de salvar scratchpad/agent-hera.md, criar memória Obsidian em `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Caio Norder/PROJECTS/redirect/2026-05-12_HH-MM_review-utm-term-fix-hera.md` com YAML frontmatter (date, project: redirect, agent: hera, type: review, tags), e RODAR EXATAMENTE:

cmux wait-for --signal done-hera-utmterm-review-1747000100
