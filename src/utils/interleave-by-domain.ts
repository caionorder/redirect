/**
 * Interface para um link ranqueado (eCPM ou RPS). Espelha a estrutura salva no Redis pelo cron
 * de ranking (ver `RedirectController.executeProcessForGroup`).
 */
export interface LinkInfo {
    url: string;
    domain: string;
    postId: string;
    ecpm: number;
    revenue: number;
    uniqueVisitors: number;
    rps: number;
}

/**
 * Ranking global: lista de links ordenados pelo critério ativo do grupo (eCPM, ou RPS com
 * fallback eCPM em grupos `bestRpsMode`).
 */
export type RankedLinksList = LinkInfo[];

/**
 * Remove itens placeholder `postId === 'random'` (legado: rankings salvos no Redis antes da
 * regra "nunca redirecionar para a rota random"). Defesa na leitura: vale no instante do deploy,
 * sem esperar o próximo ciclo do cron.
 */
export function dropRandomPlaceholders(ranking: RankedLinksList): RankedLinksList {
    return ranking.filter(l => l && l.postId !== 'random');
}

/**
 * Intercala links por domínio (round-robin) para evitar links consecutivos do mesmo domínio.
 * Recebe o ranking já ordenado pelo critério ativo do grupo (eCPM desc, ou RPS com fallback
 * eCPM quando `bestRpsMode` está ligado — ver `RedirectController.executeProcessForGroup`).
 * Em cada rodada, pega o próximo link de cada domínio (na ordem de chegada em `ranking`, ou
 * seja, do melhor item do domínio segundo o critério ativo).
 *
 * Domínios sem dados NÃO geram slot: cada domínio contribui só com os links reais que tem e
 * domínios esgotados são pulados nas rodadas seguintes. O resultado nunca contém `random`;
 * ranking vazio -> resultado vazio. O parâmetro `allDomains` é mantido por compatibilidade de
 * assinatura (a ordem dos domínios vem da primeira aparição em `ranking`).
 */
export function interleaveByDomain(ranking: RankedLinksList, _allDomains: string[]): RankedLinksList {
    // Agrupar links por domínio, mantendo a ordem de chegada (já vem ordenado pelo critério ativo).
    // Map preserva a ordem de inserção = ordem da primeira aparição de cada domínio em `ranking`
    // — critério-agnóstico: a primeira ocorrência é sempre o melhor item do domínio segundo o
    // critério ativo. Empates no critério de origem seguem a ordem do ranking de entrada.
    const domainGroups = new Map<string, LinkInfo[]>();
    for (const link of ranking) {
        let group = domainGroups.get(link.domain);
        if (!group) {
            group = [];
            domainGroups.set(link.domain, group);
        }
        group.push(link);
    }

    const groups = Array.from(domainGroups.values());
    const maxLinks = groups.reduce((m, g) => Math.max(m, g.length), 0);

    const result: RankedLinksList = [];
    for (let round = 0; round < maxLinks; round++) {
        for (const group of groups) {
            if (round < group.length) result.push(group[round]);
        }
    }
    return result;
}
