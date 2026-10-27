/**
 * Datas "YYYY-MM-DD" para o cron de ranking: o ETL do GAM grava `date` como string no fuso
 * America/Sao_Paulo, e logo após a virada do dia (ou num deploy às 00h) ainda não há linhas de
 * "hoje" — o cron então olha alguns dias para trás em vez de ficar sem ranking.
 */

export const RANKING_TIMEZONE = 'America/Sao_Paulo';

/** Máximo de dias para trás que o cron aceita usar quando "hoje" ainda não tem dados. */
export const MAX_LOOKBACK_DAYS = 3;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Formata um instante como YYYY-MM-DD no fuso informado (default: America/Sao_Paulo). */
export function formatDateInTz(date: Date, timeZone: string = RANKING_TIMEZONE): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
}

/**
 * Subtrai `days` dias de uma data YYYY-MM-DD. Aritmética de calendário em UTC (sem fuso/DST),
 * então virada de mês/ano e anos bissextos saem corretos.
 */
export function subtractDays(dateStr: string, days: number): string {
    const m = DATE_RE.exec(dateStr);
    if (!m) throw new Error(`Data inválida (esperado YYYY-MM-DD): ${dateStr}`);
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const shifted = new Date(Date.UTC(y, mo - 1, d - days));
    return shifted.toISOString().slice(0, 10);
}

/** As `n` datas anteriores a `todayStr`, da mais recente para a mais antiga (ontem primeiro). */
export function previousDates(todayStr: string, n: number): string[] {
    const out: string[] = [];
    for (let i = 1; i <= n; i++) out.push(subtractDays(todayStr, i));
    return out;
}

/** Candidatas em ordem de preferência: hoje, ontem, ..., hoje-`maxLookback`. */
export function lookbackDates(todayStr: string, maxLookback: number = MAX_LOOKBACK_DAYS): string[] {
    return [todayStr, ...previousDates(todayStr, maxLookback)];
}
