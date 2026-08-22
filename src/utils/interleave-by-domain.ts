import { generateRandomPath } from '../config/domains';

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
 * Intercala links por domínio (round-robin) para evitar links consecutivos do mesmo domínio.
 * Recebe o ranking já ordenado pelo critério ativo do grupo (eCPM desc, ou RPS com fallback
 * eCPM quando `bestRpsMode` está ligado — ver `RedirectController.executeProcessForGroup`).
 * Em cada rodada, pega o próximo link de cada domínio (na ordem de chegada em `ranking`, ou
 * seja, do melhor item do domínio segundo o critério ativo).
 */
export function interleaveByDomain(ranking: RankedLinksList, allDomains: string[]): RankedLinksList {
    // Agrupar links por domínio, mantendo a ordem de chegada (já vem ordenado pelo critério ativo)
    const domainGroups = new Map<string, LinkInfo[]>();

    for (const link of ranking) {
        if (!domainGroups.has(link.domain)) {
            domainGroups.set(link.domain, []);
        }
        domainGroups.get(link.domain)!.push(link);
    }

    // Ordem dos domínios: primeiro os que têm dados, depois os sem dados
    const domainsWithData = allDomains.filter(d => domainGroups.has(d) && domainGroups.get(d)!.length > 0);
    const domainsWithoutData = allDomains.filter(d => !domainGroups.has(d) || domainGroups.get(d)!.length === 0);

    // Ordenar domínios com dados pela posição da primeira ocorrência do domínio em `ranking`
    // — critério-agnóstico: como `ranking` já vem ordenado pelo critério ativo, a primeira
    // ocorrência de cada domínio é sempre o melhor item daquele domínio segundo esse
    // critério (eCPM puro, ou RPS-com-fallback em grupos bestRpsMode). Em caso de empate no
    // critério de origem (ex.: eCPM arredondado a 2 casas), o desempate segue o do ranking de
    // entrada (revenue desc), não a ordem de cadastro do grupo — mudança consciente em relação
    // ao comportamento anterior (que desempatava por ordem de `allDomains`).
    const firstIndexByDomain = new Map<string, number>();
    for (let i = 0; i < ranking.length; i++) {
        if (!firstIndexByDomain.has(ranking[i].domain)) {
            firstIndexByDomain.set(ranking[i].domain, i);
        }
    }
    domainsWithData.sort((a, b) => firstIndexByDomain.get(a)! - firstIndexByDomain.get(b)!);

    const domainOrder = [...domainsWithData, ...domainsWithoutData];

    // Descobrir o máximo de links que qualquer domínio tem
    const maxLinks = Math.max(1, ...Array.from(domainGroups.values()).map(g => g.length));

    // Round-robin: em cada rodada, passa por TODOS os domínios
    // Se o domínio tem link na rodada -> usa o link
    // Se não tem (sem dados ou já esgotou) -> /random daquele domínio
    const result: RankedLinksList = [];

    for (let round = 0; round < maxLinks; round++) {
        for (const domain of domainOrder) {
            const group = domainGroups.get(domain);
            if (group && round < group.length) {
                result.push(group[round]);
            } else {
                result.push({
                    url: `https://${domain}${generateRandomPath()}`,
                    domain: domain,
                    postId: 'random',
                    ecpm: 0,
                    revenue: 0,
                    uniqueVisitors: 0,
                    rps: 0
                });
            }
        }
    }

    return result;
}
