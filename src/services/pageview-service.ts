const PAGEVIEW_API_URL = 'https://pageview.joinads.me/api/report-all/0f99f85f-ae1f-4028-a414-b47b1740083e';
const TIMEOUT_MS = 5000;

interface PageviewResult {
    pageview: number;
    unique: number;
}

interface PageviewApiResponse {
    status: string;
    data: {
        pageview: number;
        unique: number;
    };
}

interface BulkPageviewItem {
    domain: string;
    postId: string;
}

export class PageviewService {
    /**
     * Busca pageviews e unique visitors de um post via API pageview.joinads.me.
     * Retorna { pageview, unique } ou null em caso de erro.
     */
    async fetchPageviews(domain: string, postId: string, date: string): Promise<PageviewResult | null> {
        try {
            const response = await fetch(PAGEVIEW_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: date,
                    from: date,
                    domain: domain,
                    type: 'all',
                    id_post: postId,
                    count: true
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });

            if (!response.ok) return null;

            const json = await response.json() as PageviewApiResponse;
            if (json.status !== 'success' || !json.data) return null;

            return { pageview: json.data.pageview, unique: json.data.unique };
        } catch (error) {
            console.error(`[PAGEVIEW] Erro ao buscar pageviews para ${domain} p=${postId}:`, error instanceof Error ? error.message : error);
            return null;
        }
    }

    /**
     * Busca pageviews em paralelo para múltiplos itens.
     * Retorna um Map onde a key é `${domain}_${postId}` e o valor é { pageview, unique }.
     */
    async fetchBulkPageviews(items: BulkPageviewItem[], date: string): Promise<Map<string, PageviewResult>> {
        const results = await Promise.allSettled(
            items.map(item => this.fetchPageviews(item.domain, item.postId, date))
        );

        const map = new Map<string, PageviewResult>();

        for (let i = 0; i < items.length; i++) {
            const result = results[i];
            if (result.status === 'fulfilled' && result.value) {
                const key = `${items[i].domain}_${items[i].postId}`;
                map.set(key, result.value);
            }
        }

        return map;
    }
}
