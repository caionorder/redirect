const UNIQUES_API_URL = 'https://pageview.joinads.me/api/report-key-value-first/0f99f85f-ae1f-4028-a414-b47b1740083e';
const TIMEOUT_MS = 3000;

interface UniquesApiResponse {
    status: string;
    data: Array<{ visitas: number }>;
}

interface BulkUniquesItem {
    domain: string;
    postId: string;
}

export class PageviewService {
    /**
     * Busca o número de visitantes únicos de um post específico via API
     * `report-key-value-first` (filtra por `id_post_wp=<postId>` no key-value). Retorna `null`
     * em erro/timeout/status diferente de 'success'/payload inesperado; post inexistente
     * retorna 0 (não null).
     *
     * IMPORTANTE: o endpoint irmão `report-all` (modo `count`, usado por um `fetchPageviews`
     * removido em 2026-08-22 por ser código morto) IGNORA o parâmetro `id_post` — retorna o
     * total do DOMÍNIO inteiro, não do post. Verificado ao vivo em 2026-08-22. Não reintroduzir
     * `report-all` para métricas per-post; `report-key-value-first` é o único endpoint que de
     * fato filtra por post.
     */
    async fetchUniqueVisitors(domain: string, postId: string, date: string): Promise<number | null> {
        try {
            const response = await fetch(UNIQUES_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    domain: domain,
                    to: date,
                    from: date,
                    keyvalue: `id_post_wp=${postId}`
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });

            if (!response.ok) {
                console.error(`[PAGEVIEW] Erro ao buscar uniques para ${domain} p=${postId}: HTTP ${response.status}`);
                return null;
            }

            const json = await response.json() as UniquesApiResponse;
            if (json.status !== 'success' || !Array.isArray(json.data)) return null;

            const visitas = json.data[0]?.visitas;
            if (typeof visitas !== 'number' || !Number.isFinite(visitas)) return null;

            return visitas;
        } catch (error) {
            console.error(`[PAGEVIEW] Erro ao buscar uniques para ${domain} p=${postId}:`, error instanceof Error ? error.message : error);
            return null;
        }
    }

    /**
     * Busca uniques por post com throttle (lotes sequenciais de `concurrency` chamadas
     * simultâneas, para não sobrecarregar a API de pageviews).
     * Retorna um Map onde a key é `${domain}_${postId}` e o valor são os uniques do post.
     * Falhas (fetchUniqueVisitors retornando null) ficam de fora do map.
     */
    async fetchBulkUniques(items: BulkUniquesItem[], date: string, concurrency: number = 3): Promise<Map<string, number>> {
        const map = new Map<string, number>();
        const total = items.length;
        const totalBatches = Math.ceil(total / concurrency);

        console.log(`[PAGEVIEW] Buscando uniques: ${total} itens em ${totalBatches} lotes de ${concurrency}`);

        for (let i = 0; i < items.length; i += concurrency) {
            const batch = items.slice(i, i + concurrency);
            const batchNum = Math.floor(i / concurrency) + 1;
            const results = await Promise.allSettled(
                batch.map(item => this.fetchUniqueVisitors(item.domain, item.postId, date))
            );

            let batchOk = 0;
            for (let j = 0; j < batch.length; j++) {
                const result = results[j];
                if (result.status === 'fulfilled' && result.value !== null) {
                    const key = `${batch[j].domain}_${batch[j].postId}`;
                    map.set(key, result.value);
                    batchOk++;
                }
            }

            console.log(`[PAGEVIEW] Lote ${batchNum}/${totalBatches}: ${batchOk}/${batch.length} ok (${map.size}/${total} total)`);
        }

        console.log(`[PAGEVIEW] Concluído: ${map.size}/${total} uniques obtidos`);
        return map;
    }
}
