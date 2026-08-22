/**
 * Aritmética pura por trás do ranking por RPS (revenue / uniques) usado em grupos com
 * `bestRpsMode: true`. Extraída de `RedirectController` para poder ser testada isoladamente.
 * Ver histórico: ranking por RPS existiu até 27/07/2026 e foi removido porque a API de
 * pageviews não tinha dados per-post; reativado em 2026-08-22 com o endpoint correto
 * (`report-key-value-first`) e um piso mínimo de uniques para evitar RPS instável em amostras
 * pequenas.
 */

/**
 * Calcula o RPS (revenue por unique visitor) de um item, ou `null` se `uniques` for
 * indefinido, não-finito (NaN/Infinity), <= 0, ou menor que `minUniques`, ou se `revenue` não
 * for um número finito (dado sujo upstream, ex.: NaN/Infinity vindo do ranking eCPM ou da API de
 * pageviews) — nesses casos o item não tem RPS confiável e deve cair no fallback eCPM em vez de
 * ser descartado (nunca esvaziar o ranking) ou de propagar um NaN/Infinity "válido" para
 * `sortRpsWithEcpmFallback`.
 */
export function computeRps(revenue: number, uniques: number | undefined, minUniques: number): number | null {
    if (uniques === undefined || !Number.isFinite(uniques) || uniques <= 0 || uniques < minUniques || !Number.isFinite(revenue)) return null;
    return revenue / uniques;
}

export interface RpsRankable {
    rps: number | null;
    ecpm: number;
    revenue: number;
}

/**
 * Ordena itens priorizando RPS válido (rps desc, desempate ecpm desc, depois revenue desc);
 * itens sem RPS válido (`rps === null`) vão depois, ordenados por eCPM desc (desempate revenue
 * desc) — mesmo critério do ranking eCPM atual. Se nenhum item tiver RPS válido, o resultado é
 * idêntico ao ranking eCPM puro. Não muta o array de entrada.
 */
export function sortRpsWithEcpmFallback<T extends RpsRankable>(items: T[]): T[] {
    const withRps = items.filter(item => item.rps !== null);
    const withoutRps = items.filter(item => item.rps === null);

    withRps.sort((a, b) => (b.rps! - a.rps!) || (b.ecpm - a.ecpm) || (b.revenue - a.revenue));
    withoutRps.sort((a, b) => (b.ecpm - a.ecpm) || (b.revenue - a.revenue));

    return [...withRps, ...withoutRps];
}
