import { LinkInfo, RankedLinksList } from './interleave-by-domain';

/**
 * Escolha do link quando o IP já visitou todos os domínios do grupo na hora (bestRps
 * "exhausted"): serve o PRÓXIMO post real do ranking, rotacionando pelo contador global do slug.
 * Nunca fabrica destino — ranking vazio devolve null (o chamador trata). Função pura.
 */
export function pickExhaustedLink(
    ranking: RankedLinksList,
    visitIndex: number
): { link: LinkInfo; index: number } | null {
    if (ranking.length === 0) return null;
    const index = visitIndex % ranking.length;
    return { link: ranking[index], index };
}
