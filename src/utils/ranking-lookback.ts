/**
 * Escolha do dia de dados do GAM para o cron de ranking: percorre as datas candidatas em ordem de
 * preferência (hoje, ontem, ...) e devolve o PRIMEIRO dia cujos dados são utilizáveis. Para de
 * consultar assim que acha — só paga as consultas dos dias anteriores quando eles vieram sem dado.
 * Erro do `fetchDay` propaga (o cron trata por grupo), sem engolir nem pular o dia.
 * Nenhum dia utilizável -> null (o chamador mantém o comportamento de "sem dado para processar").
 */
export async function pickFirstUsableDay<T>(
    candidates: string[],
    fetchDay: (date: string) => Promise<T>,
    isUsable: (rows: T) => boolean
): Promise<{ date: string; rows: T; lookbackDays: number } | null> {
    for (let i = 0; i < candidates.length; i++) {
        const rows = await fetchDay(candidates[i]);
        if (isUsable(rows)) return { date: candidates[i], rows, lookbackDays: i };
    }
    return null;
}
