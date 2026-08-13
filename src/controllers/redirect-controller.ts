import { Request, Response } from 'express';
import { Db } from 'mongodb';
import * as cron from 'node-cron';
import cluster from 'cluster';
import { SuperFilterService } from '../services/superfilter-service';
import { GamAdUnitRepository } from '../repositories/gam-ad-unit-repository';
import { RedirectLinkRepository } from '../repositories/redirect-link-repository';
import { RedirectClickRepository } from '../repositories/redirect-click-repository';
import { BroadClickRepository } from '../repositories/broad-click-repository';
import { IFilterRequest } from '../interfaces/filter-interfaces';
import { redis } from '../config/redis';
import { generateRandomPath } from '../config/domains';
import { DomainGroupService } from '../services/domain-group-service';
import { isExplorationRequest, decideServingSource } from '../utils/exploration-math';
import { normalizeGamDomain } from '../utils/domain-normalize';

/**
 * Interface para um link com eCPM
 */
interface LinkInfo {
    url: string;
    domain: string;
    postId: string;
    ecpm: number;
    revenue: number;
    uniqueVisitors: number;
    rps: number;
}

/**
 * Ranking global: lista de links ordenados por eCPM (do maior para o menor)
 */
type RankedLinksList = LinkInfo[];

/**
 * Interface para regras de redirecionamento condicional
 */
interface RedirectRule {
    id: string;
    conditions: { [key: string]: string };
    destination: string;
    passQueryParams: boolean;
    active: boolean;
    description: string;
}

/**
 * Resultado da busca de post IDs válidos de um domínio.
 * Diferencia "API retornou dados" de "API falhou".
 */
interface FetchPostIdsResult {
    success: boolean;
    ids: Set<string>;
}

/**
 * Estado da paginação de um endpoint WP REST (posts ou pages):
 * - 'clean': terminou naturalmente (lista vazia, última página parcial, ou HTTP 400 em página > 1
 *   — o WordPress usa esse código para "página além do total", ou seja, fim de catálogo, não erro).
 * - 'failed': a primeira página nunca respondeu (endpoint ausente/indisponível).
 * - 'truncated': a paginação começou mas foi interrompida por uma resposta não-OK (exceto o 400
 *   acima) ou por erro de rede/timeout — o conjunto de IDs coletado até ali é parcial, não confiável.
 */
type EndpointFetchStatus = 'clean' | 'failed' | 'truncated';

/**
 * Entrada do cache de posts válidos por domínio, com timestamp individual —
 * cada domínio expira de forma independente, não pelo relógio de outro domínio.
 * `consecutiveFallbacks` conta quantas renovações seguidas reaproveitaram um resultado antigo
 * (API falhando) em vez de um fetch bem-sucedido; zera a cada sucesso.
 */
interface ValidPostsCacheEntry {
    result: FetchPostIdsResult;
    fetchedAt: number;
    consecutiveFallbacks: number;
}

/**
 * Interface para regras de redirecionamento fora do in-app browser
 * Se o usuario NAO esta no in-app (Facebook/Instagram) e a utm_campaign bate, redireciona
 */
interface InAppRule {
    id: string;
    utm_campaign: string;
    destination: string;
    passQueryParams: boolean;
    active: boolean;
    description: string;
}

export class RedirectController {
    private superFilterService: SuperFilterService;
    private gamAdUnitRepository?: GamAdUnitRepository;
    private redirectLinkRepository?: RedirectLinkRepository;
    private redirectClickRepository?: RedirectClickRepository;
    private broadClickRepository?: BroadClickRepository;
    private redisClient: typeof redis | null;
    private domainGroupService: DomainGroupService;

    // Chaves Redis
    private readonly VISITOR_PREFIX = 'visitor';

    // Chave Redis para regras de redirecionamento
    private readonly REDIRECT_RULES_KEY = 'redirect:rules';

    // Chave Redis para regras de in-app
    private readonly INAPP_RULES_KEY = 'redirect:inapp_rules';

    // Cache genérico por slug: { data: RankedLinksList, time: number }
    private bestLinksMapCaches: Map<string, { data: RankedLinksList; time: number }> = new Map();
    private readonly CACHE_TTL_MS = 60000; // 1 minuto de cache em memória

    // Cache em memória do pool de exploração por slug (mesmo padrão de bestLinksMapCaches)
    private explorationPoolCaches: Map<string, { data: RankedLinksList; time: number }> = new Map();

    // 1 a cada N requests (1/N do tráfego) vai para o pool de exploração em vez do ranking/bestRps
    private readonly EXPLORATION_MOD = 20;

    // Tamanho máximo do pool de exploração salvo por grupo a cada ciclo do cron
    private readonly EXPLORATION_POOL_CAP = 300;

    // Amostra máxima de candidatos de exploração por domínio a cada ciclo do cron
    private readonly EXPLORATION_SAMPLE_PER_DOMAIN = 30;

    // Cache em memória para regras de redirecionamento
    private rulesCache: RedirectRule[] | null = null;
    private rulesCacheTime: number = 0;

    // Cache em memória para regras de in-app
    private inAppRulesCache: InAppRule[] | null = null;
    private inAppRulesCacheTime: number = 0;

    // Cache em memória para posts válidos por domínio, com TTL por entrada (cada domínio expira
    // no seu próprio horário — grupos diferentes não resetam o relógio uns dos outros)
    private validPostsCache: Map<string, ValidPostsCacheEntry> = new Map();
    private readonly VALID_POSTS_CACHE_TTL_MS = 3600000; // 60 minutos — cobre ~4 ciclos do cron de 15 min

    // Debug flag — habilita console.log per-request quando DEBUG_REDIRECT=1
    private static readonly DEBUG_REDIRECT = process.env.DEBUG_REDIRECT === '1';

    // Domínios com lógica invertida de idioma (apenas estes recebem prefixo)
    private static readonly INVERTED_LANG_DOMAINS = new Set<string>([
        'appmobile4u.com',
        'appcombos.com',
        'informanoticia.com',
        'buscaapp.com.br',
        'lavoriinitalia.com',
    ]);

    constructor(db?: Db) {
        this.superFilterService = new SuperFilterService();
        this.redisClient = redis;
        this.domainGroupService = DomainGroupService.getInstance(db);

        if (db) {
            this.gamAdUnitRepository = new GamAdUnitRepository(db);
            this.redirectLinkRepository = new RedirectLinkRepository(db);
            this.redirectClickRepository = new RedirectClickRepository(db);
            this.broadClickRepository = new BroadClickRepository(db);
        }

        const isMainProcess = !cluster.isWorker || cluster.worker?.id === 1;
        if (isMainProcess) {
            this.initializeScheduledProcess();
        }
    }

    /**
     * Retorna a chave Redis para o ranking de um grupo.
     * Mantém compatibilidade com chaves antigas para 'main' e 'db'.
     */
    private getRedisKeyForGroup(slug: string): string {
        if (slug === 'main') return 'redirect:best_links_map';
        if (slug === 'db') return 'redirect:best_links_map_db';
        return `redirect:best_links_map:${slug}`;
    }

    /**
     * Retorna a chave Redis para o pool de exploração de um grupo.
     */
    private getRedisKeyForExplorationPool(slug: string): string {
        return `redirect:exploration_pool:${slug}`;
    }

    /**
     * Cron: a cada 15 minutos - busca ranking de eCPM de TODOS os grupos ativos
     */
    private initializeScheduledProcess(): void {
        console.log('[CRON] Inicializando agendamento - executará a cada 15 minutos');

        // Executar imediatamente na inicialização para popular o cache de todos os grupos
        this.executeAllGroups()
            .then(() => console.log('[CRON] Cache inicial de todos os grupos populado com sucesso'))
            .catch(err => console.error('[CRON] Erro ao popular cache inicial:', err));

        // Agendar para rodar a cada 15 minutos
        const task = cron.schedule('*/15 * * * *', async () => {
            console.log('[CRON] Executando atualização agendada...');
            try {
                await this.executeAllGroups();
            } catch (error) {
                console.error('[CRON] Erro:', error);
            }
        });
        task.start();
    }

    /**
     * Executa o processo de ranking eCPM para TODOS os grupos ativos
     */
    private async executeAllGroups(): Promise<void> {
        const slugs = await this.domainGroupService.getActiveSlugs();
        for (const slug of slugs) {
            try {
                await this.executeProcessForGroup(slug);
            } catch (error) {
                console.error(`[CRON-${slug.toUpperCase()}] Erro:`, error);
            }
        }
    }

    /**
     * Busca em todos os domínios de um grupo os posts e cria ranking global por eCPM (do maior para o menor).
     * Salva no Redis uma lista: [{ url, domain, postId, ecpm, revenue, uniqueVisitors, rps }, ...]
     * `uniqueVisitors` e `rps` são sempre 0 — mantidos apenas por compatibilidade de payload com consumidores existentes.
     */
    private async executeProcessForGroup(slug: string): Promise<RankedLinksList | null> {
        const groupDomains = await this.domainGroupService.getDomains(slug);
        if (groupDomains.length === 0) {
            console.log(`[CRON-${slug.toUpperCase()}] Nenhum domínio configurado`);
            return null;
        }

        // Data de hoje no fuso America/Sao_Paulo — bate com o `date` gravado pelo ETL.
        // Sem isso, em servidor UTC, das 21h-00h BRT a query erra o dia.
        const todayStr = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date());

        // Desde 05-08/08/2026 o GAM passou a retornar o domain do ETL com underscore(s) final(is)
        // após um rename de ad units (ex.: `dopeaaps.com_`) — a query precisa casar as duas
        // formas, senão os domínios afetados somem do resultado inteiro. Normalização do valor
        // de volta acontece no loop abaixo, antes de qualquer uso (ver normalizeGamDomain).
        const filterRequest: IFilterRequest = {
            start: todayStr,
            end: todayStr,
            domain: [...groupDomains, ...groupDomains.map(d => `${d}_`)],
            custom_key: "id_post_wp",
            group: ["domain", "custom_key", "custom_value"]
        };

        if (!this.gamAdUnitRepository) {
            throw new Error('Database not connected');
        }

        const data = await this.superFilterService.execute(filterRequest, this.gamAdUnitRepository);

        if (!Array.isArray(data) || data.length === 0) {
            console.log(`[CRON-${slug.toUpperCase()}] Nenhum dado encontrado para processar`);
            return null;
        }

        // Criar lista global de todos os links. Dedup por `domain:postId` (chave pós-normalização)
        // — em dias de transição do rename do GAM (ver comentário no filterRequest acima), a
        // mesma combinação domínio+post pode vir em DUAS linhas (`dopeaaps.com` e
        // `dopeaaps.com_`), já que a query casa as duas formas mas o agrupamento do superfilter é
        // por domain+custom_value (pré-normalização). Mantém só o item de MAIOR revenue e
        // descarta o outro — nunca soma (mudaria o eCPM, que já vem calculado do GAM).
        const dedupedByKey = new Map<string, LinkInfo>();

        let skipped = 0;
        for (const item of data) {
            if (!item.domain || !item.custom_value) continue;

            const impressions = Number(item.impressions || 0);
            if (impressions < 100) {
                skipped++;
                continue;
            }

            const domain = normalizeGamDomain(String(item.domain));
            const parsedEcpm = parseFloat(String(item.ecpm || 0));
            const ecpm = Number.isFinite(parsedEcpm) ? parsedEcpm : 0;
            const postId = String(item.custom_value);
            const revenue = Number(item.revenue || 0);

            const key = `${domain}:${postId}`;
            const existing = dedupedByKey.get(key);
            if (existing && existing.revenue >= revenue) continue;

            dedupedByKey.set(key, {
                url: `https://${domain}/?p=${encodeURIComponent(postId)}`,
                domain: domain,
                postId: postId,
                ecpm: ecpm,
                revenue: revenue,
                uniqueVisitors: 0,
                rps: 0
            });
        }

        const globalRanking: RankedLinksList = Array.from(dedupedByKey.values());

        // Ordenar por eCPM desc (desempate por revenue, já que o eCPM chega arredondado a 2 casas)
        globalRanking.sort((a, b) => (b.ecpm - a.ecpm) || (b.revenue - a.revenue));

        // Limitar a 10 itens por domínio (top 10 por eCPM de cada domínio, desempate por revenue)
        const domainCounts = new Map<string, number>();
        const limitedRanking = globalRanking.filter(item => {
            const count = domainCounts.get(item.domain) || 0;
            if (count >= 10) return false;
            domainCounts.set(item.domain, count + 1);
            return true;
        });

        console.log(`[CRON-${slug.toUpperCase()}] Ranking limitado: ${limitedRanking.length} itens (de ${globalRanking.length}, max 10 por domínio)`);

        // O interleave exige ordem eCPM-desc; este sort garante isso independentemente
        // do critério usado no corte acima.
        limitedRanking.sort((a, b) => (b.ecpm - a.ecpm) || (b.revenue - a.revenue));

        // Validar posts via API WordPress ANTES de intercalar (senão /random seria removido)
        const { ranking: validatedRanking, validPostsMap } = await this.validateRanking(limitedRanking);

        // Se não sobrou nenhum post real, manter o cache anterior
        if (validatedRanking.length === 0) {
            console.log(`[CRON-${slug.toUpperCase()}] Nenhum post com eCPM válido — mantendo cache anterior`);
            return null;
        }

        // Intercalar domínios (round-robin) — domínios sem dados entram como /random
        const interleavedRanking = this.interleaveByDomain(validatedRanking, groupDomains);

        const topRanking = interleavedRanking.slice(0, 50);

        // Salvar no cache Redis (1 hora)
        const redisKey = this.getRedisKeyForGroup(slug);
        if (this.redisClient) {
            await this.redisClient.set(
                redisKey,
                JSON.stringify(topRanking),
                'EX',
                3600
            );
            console.log(`[CRON-${slug.toUpperCase()}] Ranking global atualizado: ${topRanking.length} links no rank (${validatedRanking.length} validados, ${skipped} ignorados por <100 impressões)`);
        }

        // Log do top 5
        const top = topRanking.slice(0, 5);
        for (let i = 0; i < top.length; i++) {
            console.log(`[CRON-${slug.toUpperCase()}] #${i + 1} ${top[i].domain} p=${top[i].postId} (eCPM: ${top[i].ecpm.toFixed(4)}, revenue: ${top[i].revenue.toFixed(4)})`);
        }

        // Pool de exploração: posts válidos fora do top, para a fatia de exploração do serving.
        // Guard de Redis ANTES de montar o pool — sem Redis o resultado seria descartado (M1).
        if (this.redisClient) {
            const domainsValidatedThisCycle = [...new Set(limitedRanking.map(link => link.domain))];
            const explorationPool = await this.buildExplorationPool(
                groupDomains,
                domainsValidatedThisCycle,
                validPostsMap,
                topRanking
            );
            try {
                await this.redisClient.set(
                    this.getRedisKeyForExplorationPool(slug),
                    JSON.stringify(explorationPool),
                    'EX',
                    3600
                );
                console.log(`[CRON-${slug.toUpperCase()}] Pool de exploração: ${explorationPool.length} itens`);
            } catch (err) {
                // Falha ao salvar o pool não pode derrubar o process — o ranking (feature
                // existente) já foi salvo acima, antes deste bloco (ordem intencional).
                console.error(`[CRON-${slug.toUpperCase()}] Erro ao salvar pool de exploração:`, err);
            }
        }

        return topRanking;
    }

    /**
     * Monta o pool de exploração de um grupo: posts válidos por domínio que NÃO estão no
     * `topRanking` deste ciclo. Amostra até `EXPLORATION_SAMPLE_PER_DOMAIN` candidatos aleatórios
     * por domínio (a re-amostragem a cada 15 min dá rotação natural sobre o catálogo inteiro) e
     * intercala por domínio, priorizando os domínios menos representados no topRanking, com cap
     * de `EXPLORATION_POOL_CAP` itens.
     *
     * Universo de domínios é `groupDomains` (TODO o grupo), não só os que monetizaram hoje —
     * senão um domínio novo/sem receita nunca ganharia exploração de post, só o `/random` do
     * `interleaveByDomain`, o que deixaria o loop de retroalimentação fechado no eixo domínio.
     *
     * Custo de rede: domínios em `domainsValidatedThisCycle` (já tentados por `validateRanking`
     * neste ciclo, saudáveis ou não) reaproveitam `validPostsMapFromRanking` — zero chamadas WP
     * extra. Domínios de `groupDomains` fora dessa lista (sem dado GAM hoje) são buscados aqui
     * pela primeira vez, via `fetchAllValidPosts` (cache de 60min por domínio segura o custo em
     * ciclos seguintes). Domínios que falharam a validação NESTE ciclo não são re-tentados aqui —
     * ficam fora do pool deste ciclo, com retry natural no próximo cron (mesma política de
     * `fetchAllValidPosts`/b10cd19: um refetch com falha nunca é forçado no mesmo ciclo).
     */
    private async buildExplorationPool(
        groupDomains: string[],
        domainsValidatedThisCycle: string[],
        validPostsMapFromRanking: Map<string, FetchPostIdsResult>,
        topRanking: RankedLinksList
    ): Promise<RankedLinksList> {
        if (groupDomains.length === 0) return [];

        const validatedSet = new Set(domainsValidatedThisCycle);
        const extraDomains = groupDomains.filter(d => !validatedSet.has(d));

        let validPostsMap = validPostsMapFromRanking;
        if (extraDomains.length > 0) {
            const extraResults = await this.fetchAllValidPosts(extraDomains);
            validPostsMap = new Map(validPostsMapFromRanking);
            for (const [domain, result] of extraResults) {
                validPostsMap.set(domain, result);
            }
        }

        const topSet = new Set<string>();
        for (const item of topRanking) {
            topSet.add(`${item.domain}:${item.postId}`);
        }

        // Candidatos por domínio: IDs válidos fora do top, amostrados (shuffle parcial) e
        // limitados a EXPLORATION_SAMPLE_PER_DOMAIN
        const candidatesByDomain = new Map<string, string[]>();
        for (const domain of groupDomains) {
            const result = validPostsMap.get(domain);
            if (!result || !result.success || result.ids.size === 0) continue;

            const candidates: string[] = [];
            for (const postId of result.ids) {
                if (!topSet.has(`${domain}:${postId}`)) candidates.push(postId);
            }
            if (candidates.length === 0) continue;

            // Shuffle parcial (Fisher-Yates truncado): só os primeiros `sampleSize` swaps são
            // necessários para uma amostra uniforme sem viés — não precisa embaralhar o catálogo
            // WP inteiro (pode ter milhares de IDs, paginação sem teto) só para aproveitar poucos.
            const sampleSize = Math.min(this.EXPLORATION_SAMPLE_PER_DOMAIN, candidates.length);
            for (let i = 0; i < sampleSize; i++) {
                const j = i + Math.floor(Math.random() * (candidates.length - i));
                [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
            }
            candidatesByDomain.set(domain, candidates.slice(0, sampleSize));
        }

        if (candidatesByDomain.size === 0) return [];

        // Ordem dos domínios: menos representados no topRanking primeiro
        const topCountByDomain = new Map<string, number>();
        for (const item of topRanking) {
            topCountByDomain.set(item.domain, (topCountByDomain.get(item.domain) || 0) + 1);
        }
        const domainOrder = [...candidatesByDomain.keys()].sort(
            (a, b) => (topCountByDomain.get(a) || 0) - (topCountByDomain.get(b) || 0)
        );

        const maxCandidates = Math.max(...Array.from(candidatesByDomain.values()).map(c => c.length));
        const pool: RankedLinksList = [];

        for (let round = 0; round < maxCandidates && pool.length < this.EXPLORATION_POOL_CAP; round++) {
            for (const domain of domainOrder) {
                if (pool.length >= this.EXPLORATION_POOL_CAP) break;
                const list = candidatesByDomain.get(domain)!;
                if (round >= list.length) continue;
                const postId = list[round];
                pool.push({
                    url: `https://${domain}/?p=${encodeURIComponent(postId)}`,
                    domain: domain,
                    postId: postId,
                    ecpm: 0,
                    revenue: 0,
                    uniqueVisitors: 0,
                    rps: 0
                });
            }
        }

        return pool;
    }

    /**
     * Busca IDs paginados de um endpoint WP REST API (posts ou pages).
     * Retorna o `EndpointFetchStatus` da paginação — ver definição do tipo para os três casos.
     * Erro de rede/timeout é tratado como a página atual: 'failed' se ocorreu na primeira página,
     * 'truncated' se já havia páginas lidas com sucesso.
     */
    private async fetchIdsFromEndpoint(domain: string, endpoint: string, validIds: Set<string>): Promise<EndpointFetchStatus> {
        let page = 1;
        const perPage = 100;

        while (true) {
            try {
                const url = `https://${domain}/wp-json/wp/v2/${endpoint}?per_page=${perPage}&_fields=id&orderby=date&order=desc&page=${page}`;
                const response = await fetch(url, {
                    signal: AbortSignal.timeout(10000),
                    headers: { 'User-Agent': 'RedirectBot/1.0' }
                });

                if (!response.ok) {
                    if (page === 1) {
                        console.log(`[WP-VALIDATE] ${domain} ${endpoint} page=1 HTTP ${response.status} - endpoint indisponível`);
                        return 'failed';
                    }
                    if (response.status === 400) {
                        console.log(`[WP-VALIDATE] ${domain} ${endpoint} page=${page} HTTP 400 - fim natural da paginação`);
                        return 'clean';
                    }
                    console.warn(`[WP-VALIDATE] ${domain} ${endpoint} page=${page} HTTP ${response.status} - paginação interrompida (truncado)`);
                    return 'truncated';
                }

                const items = await response.json() as Array<{ id: number }>;

                if (!Array.isArray(items) || items.length === 0) return 'clean';

                for (const item of items) {
                    validIds.add(String(item.id));
                }

                if (items.length < perPage) return 'clean';
                page++;
            } catch (error) {
                if (page === 1) {
                    console.error(`[WP-VALIDATE] ${domain} ${endpoint}: erro na primeira página —`, error instanceof Error ? error.message : error);
                    return 'failed';
                }
                console.warn(`[WP-VALIDATE] ${domain} ${endpoint} page=${page}: erro de rede/timeout — paginação interrompida (truncado)`, error instanceof Error ? error.message : error);
                return 'truncated';
            }
        }
    }

    /**
     * Busca os IDs de posts e pages válidos de um domínio via API WordPress.
     * Sucesso exige pelo menos um endpoint com paginação completa ('clean') e nenhum endpoint
     * truncado. Um endpoint ausente desde a primeira página ('failed') é tolerado — nem todo
     * site expõe `/pages` —, mas um endpoint truncado no meio da paginação (rate limit, erro
     * intermitente) produz um conjunto parcial que não deve virar autoritativo: nesse caso o
     * domínio é marcado como falho, e o caller decide entre manter o cache anterior ou remover
     * os links do domínio.
     */
    private async fetchValidPostIds(domain: string): Promise<FetchPostIdsResult> {
        const validIds = new Set<string>();

        try {
            // Buscar posts e pages em paralelo
            const [postsStatus, pagesStatus] = await Promise.all([
                this.fetchIdsFromEndpoint(domain, 'posts', validIds),
                this.fetchIdsFromEndpoint(domain, 'pages', validIds),
            ]);

            const hasCleanEndpoint = postsStatus === 'clean' || pagesStatus === 'clean';
            const hasTruncatedEndpoint = postsStatus === 'truncated' || pagesStatus === 'truncated';
            const success = hasCleanEndpoint && !hasTruncatedEndpoint;

            if (!success) {
                console.error(`[WP-VALIDATE] ${domain}: validação falhou (posts: ${postsStatus}, pages: ${pagesStatus})`);
                return { success: false, ids: validIds };
            }

            console.log(`[WP-VALIDATE] ${domain}: ${validIds.size} IDs válidos encontrados (posts: ${postsStatus}, pages: ${pagesStatus})`);
            return { success: true, ids: validIds };
        } catch (error) {
            console.error(`[WP-VALIDATE] Erro ao buscar posts/pages de ${domain}:`, error instanceof Error ? error.message : error);
            return { success: false, ids: validIds };
        }
    }

    /**
     * Busca via API WordPress os domínios informados, em paralelo.
     * Se a API falhar para um domínio e houver uma entrada anterior bem-sucedida em `fallbackCache`
     * (mesmo que já expirada), reaproveita essa entrada em vez de marcar o domínio como falho —
     * um refetch com falha nunca rebaixa uma entrada boa.
     */
    private async fetchDomainsFromApi(
        domains: string[],
        fallbackCache: Map<string, ValidPostsCacheEntry>
    ): Promise<Map<string, FetchPostIdsResult>> {
        const result = new Map<string, FetchPostIdsResult>();

        const promises = domains.map(async (domain) => {
            const fetchResult = await this.fetchValidPostIds(domain);
            return { domain, fetchResult };
        });

        const results = await Promise.allSettled(promises);

        for (const r of results) {
            if (r.status === 'fulfilled') {
                const { domain, fetchResult } = r.value;

                if (!fetchResult.success) {
                    // API falhou — tentar usar cache anterior (mesmo expirado) como fallback
                    const cached = fallbackCache.get(domain)?.result;
                    if (cached && cached.success && cached.ids.size > 0) {
                        console.log(`[WP-VALIDATE] ${domain}: API falhou, usando cache anterior (${cached.ids.size} IDs)`);
                        result.set(domain, cached);
                    } else {
                        // Sem cache anterior — marcar como falha (links serão removidos)
                        console.warn(`[WP-VALIDATE] ${domain}: API falhou e sem cache anterior — links serão removidos`);
                        result.set(domain, fetchResult);
                    }
                } else {
                    result.set(domain, fetchResult);
                }
            }
        }

        return result;
    }

    /**
     * Busca posts válidos dos domínios presentes no ranking, com cache em memória por domínio
     * (TTL `VALID_POSTS_CACHE_TTL_MS`, timestamp individual por entrada — um domínio expira no seu
     * próprio horário, independente de quando outros domínios ou outros grupos foram buscados).
     * Domínios com entrada dentro do TTL reaproveitam o cache; os demais (ausentes ou expirados)
     * são buscados via API. Os resultados são sempre mesclados no cache por domínio (nunca
     * substituem o mapa inteiro), preservando entradas de domínios de outros grupos.
     * Uma falha sem fallback disponível NÃO é persistida no cache — ficaria pinada por
     * `VALID_POSTS_CACHE_TTL_MS` como se fosse uma entrada boa; deixando o domínio de fora, ele
     * volta a `missingDomains` e é re-tentado já no próximo ciclo do cron.
     * Quando um domínio reaproveita o mesmo resultado de tentativas anteriores por falhas
     * consecutivas da API (fallback), a contagem é registrada na entrada do cache; a partir da
     * 2ª renovação seguida em fallback, emite `console.warn` com a idade estimada dos dados.
     * Retorna sempre um Map novo (nunca a referência viva do cache), com uma entrada por domínio
     * pedido cuja busca resolveu, para que o caller saiba se a API falhou ou não. Se a API falhou
     * para um domínio, tenta usar o cache anterior (mesmo expirado) como fallback.
     */
    private async fetchAllValidPosts(domainsToCheck: string[]): Promise<Map<string, FetchPostIdsResult>> {
        const now = Date.now();

        const missingDomains = domainsToCheck.filter(domain => {
            const entry = this.validPostsCache.get(domain);
            return !entry || (now - entry.fetchedAt) >= this.VALID_POSTS_CACHE_TTL_MS;
        });

        if (missingDomains.length > 0) {
            console.log(`[WP-VALIDATE] Buscando ${missingDomains.length} domínio(s) ausente(s)/expirado(s), reaproveitando ${domainsToCheck.length - missingDomains.length} do cache`);
            const fetched = await this.fetchDomainsFromApi(missingDomains, this.validPostsCache);
            for (const [domain, fetchResult] of fetched) {
                const previousEntry = this.validPostsCache.get(domain);
                const isFallbackReuse = previousEntry !== undefined && previousEntry.result === fetchResult;

                if (!fetchResult.success && !isFallbackReuse) {
                    // Falha sem fallback disponível — não persistir com fetchedAt "fresco". Deixando
                    // o domínio fora do cache, ele volta a aparecer em missingDomains no próximo
                    // ciclo do cron (15 min) e é re-tentado, em vez de ficar pinado por
                    // VALID_POSTS_CACHE_TTL_MS (60 min) como se fosse uma entrada boa. O link deste
                    // domínio ainda é removido NESTE ciclo: `validateRanking` trata "ausente do mapa"
                    // e "presente com success:false" de forma idêntica.
                    continue;
                }

                let consecutiveFallbacks = 0;

                // Reaproveitou o mesmo objeto do cache anterior (fallback-por-falha) — escalar contagem
                if (isFallbackReuse && previousEntry) {
                    consecutiveFallbacks = previousEntry.consecutiveFallbacks + 1;
                    if (consecutiveFallbacks >= 2) {
                        const staleHours = (consecutiveFallbacks * this.VALID_POSTS_CACHE_TTL_MS) / 3600000;
                        console.warn(`[WP-VALIDATE] ${domain}: ${consecutiveFallbacks} renovações seguidas em fallback — IDs podem estar defasados em até ~${staleHours}h`);
                    }
                }

                this.validPostsCache.set(domain, { result: fetchResult, fetchedAt: now, consecutiveFallbacks });
            }
        } else {
            console.log(`[WP-VALIDATE] Usando cache em memória (${domainsToCheck.length} domínios deste request)`);
        }

        const result = new Map<string, FetchPostIdsResult>();
        for (const domain of domainsToCheck) {
            const entry = this.validPostsCache.get(domain);
            if (entry) result.set(domain, entry.result);
        }
        return result;
    }

    /**
     * Intercala links por domínio (round-robin) para evitar links consecutivos do mesmo domínio.
     * Recebe o ranking já ordenado por eCPM decrescente.
     * Em cada rodada, pega o próximo link de cada domínio (na ordem do melhor eCPM global do domínio).
     */
    private interleaveByDomain(ranking: RankedLinksList, allDomains: string[]): RankedLinksList {
        // Agrupar links por domínio, mantendo a ordem de eCPM (já vem ordenado)
        const domainGroups = new Map<string, LinkInfo[]>();

        for (const link of ranking) {
            if (!domainGroups.has(link.domain)) {
                domainGroups.set(link.domain, []);
            }
            domainGroups.get(link.domain)!.push(link);
        }

        // Ordem dos domínios: primeiro os que têm dados (por melhor eCPM), depois os sem dados
        const domainsWithData = allDomains.filter(d => domainGroups.has(d) && domainGroups.get(d)!.length > 0);
        const domainsWithoutData = allDomains.filter(d => !domainGroups.has(d) || domainGroups.get(d)!.length === 0);

        // Ordenar domínios com dados pelo melhor eCPM do primeiro link
        domainsWithData.sort((a, b) => domainGroups.get(b)![0].ecpm - domainGroups.get(a)![0].ecpm);

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

    /**
     * Filtra o ranking removendo posts que não existem no WordPress.
     * - Se a API respondeu com sucesso: filtra posts inexistentes.
     * - Se a API falhou E não tem cache anterior: remove todos os links do domínio.
     * - Se a API retornou 0 posts com sucesso: remove todos os links do domínio (domínio vazio).
     * Retorna também o `validPostsMap` resolvido, para o caller (hoje: `buildExplorationPool`)
     * reaproveitar sem pagar `fetchAllValidPosts` de novo para os mesmos domínios.
     */
    private async validateRanking(
        ranking: RankedLinksList
    ): Promise<{ ranking: RankedLinksList; validPostsMap: Map<string, FetchPostIdsResult> }> {
        const uniqueDomains = [...new Set(ranking.map(link => link.domain))];

        if (uniqueDomains.length === 0) return { ranking, validPostsMap: new Map() };

        const validPostsMap = await this.fetchAllValidPosts(uniqueDomains);

        let invalidCount = 0;
        let removedByFailure = 0;
        const validated = ranking.filter(link => {
            const result = validPostsMap.get(link.domain);

            // Domínio não presente no mapa (Promise rejeitada) — remover link
            if (!result) {
                removedByFailure++;
                return false;
            }

            // API falhou e sem cache anterior — remover link
            if (!result.success) {
                removedByFailure++;
                return false;
            }

            // API respondeu com sucesso mas 0 IDs — domínio sem conteúdo, remover
            if (result.ids.size === 0) {
                invalidCount++;
                return false;
            }

            // Validar se o post ID existe
            const isValid = result.ids.has(link.postId);
            if (!isValid) invalidCount++;
            return isValid;
        });

        if (invalidCount > 0 || removedByFailure > 0) {
            console.log(`[WP-VALIDATE] ${invalidCount} links removidos por post inexistente, ${removedByFailure} removidos por falha de API (${ranking.length} -> ${validated.length})`);
        }

        return { ranking: validated, validPostsMap };
    }

    /**
     * Endpoint manual: GET /api/process
     * Aceita query param ?slug=main|db|... para executar um grupo específico.
     * Sem slug, executa TODOS os grupos ativos e retorna todos os rankings.
     */
    public async process(req: Request, res: Response): Promise<void> {
        try {
            const slugParam = typeof req.query.slug === 'string' ? req.query.slug : undefined;

            if (slugParam) {
                // Executar apenas o grupo solicitado
                await this.executeProcessForGroup(slugParam);
                const ranking = await this.getBestLinksMapForGroup(slugParam);
                res.status(200).json({
                    success: true,
                    message: `Process executado para o grupo '${slugParam}'`,
                    slug: slugParam,
                    data: ranking
                });
            } else {
                // Executar todos os grupos e retornar todos os rankings
                await this.executeAllGroups();
                const slugs = await this.domainGroupService.getActiveSlugs();
                const allRankings: Record<string, RankedLinksList | null> = {};
                for (const slug of slugs) {
                    allRankings[slug] = await this.getBestLinksMapForGroup(slug);
                }
                res.status(200).json({
                    success: true,
                    message: 'Process executado para todos os grupos',
                    data: allRankings
                });
            }
        } catch (error) {
            console.error('Error processing filter:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }

    /**
     * Gera a chave de visitante para rastreamento global
     * Formato: visitor:{type}:{ip}:{hora}
     */
    private getVisitorKey(ip: string, type: string): string {
        const hour = new Date().getHours();
        return `${this.VISITOR_PREFIX}:${type}:${ip}:${hour}`;
    }

    /**
     * Counter global por slug — cada request incrementa, independente de IP.
     * Retorna o índice (0-based) para usar no ranking.
     */
    private async getGlobalVisitIndex(slug: string): Promise<number> {
        if (!this.redisClient) return 0;

        const key = `redirect:global_counter:${slug}`;
        try {
            const count = await this.redisClient.incr(key);
            // TTL de 1 hora — reseta o counter a cada hora
            if (count === 1) {
                await this.redisClient.expire(key, 3600);
            }
            return count - 1;
        } catch (err) {
            console.error('[REDIS] getGlobalVisitIndex failed', err);
            return 0;
        }
    }

    /**
     * Adiciona um domínio à lista de visitados e define TTL de 1h na primeira inserção.
     * `type` é o mesmo parâmetro repassado a `getVisitorKey` (aceita qualquer slug de grupo,
     * não só 'main'/'db' — usado também pelo branch de exploração em grupos com `bestRpsMode`
     * para manter o rodízio por IP do `getBestRpsLink` coerente).
     */
    private async addVisitedDomain(ip: string, type: string, domain: string): Promise<void> {
        if (!this.redisClient) return;
        const key = this.getVisitorKey(ip, type);
        try {
            const added = await this.redisClient.sadd(key, domain);
            // Se foi o primeiro elemento adicionado, setar TTL
            if (added === 1) {
                const ttl = await this.redisClient.ttl(key);
                if (ttl === -1) {
                    await this.redisClient.expire(key, 3600);
                }
            }
        } catch (err) {
            console.error('[REDIS] addVisitedDomain failed', err);
        }
    }

    /**
     * Best RPS mode: the saved ranking is interleaved by domain (round-robin), not globally
     * sorted — round 0 holds the best-eCPM link of each domain, round 1 the second-best, etc.
     * Iterating it in order and returning the first unvisited domain therefore serves the
     * highest-eCPM link of each domain the user hasn't seen this hour.
     * Falls back to random if all domains are exhausted.
     * Naming (`bestrps_*`, `BEST_RPS`, this function name) is frozen: linkIds are the key used
     * by redirects_clicks for click attribution — do not rename even though "RPS" no longer applies.
     */
    private async getBestRpsLink(
        clientIp: string,
        slug: string,
        ranking: RankedLinksList,
        groupDomains: string[]
    ): Promise<{ url: string; domain: string; linkId: string; logType: string }> {
        const visitorKey = this.getVisitorKey(clientIp, slug);

        // Get visited domains for this IP + slug + hour
        let visitedDomains: Set<string> = new Set();
        if (this.redisClient) {
            try {
                const members = await this.redisClient.smembers(visitorKey);
                visitedDomains = new Set(members);
            } catch (error) {
                console.error(`[BEST_RPS] Error reading visited domains:`, error);
            }
        }

        // Iterate the domain-interleaved ranking — round 0 is each domain's best eCPM link,
        // so the first unvisited domain found here is that domain's top link.
        for (let i = 0; i < ranking.length; i++) {
            const link = ranking[i];
            if (!visitedDomains.has(link.domain)) {
                // Mark domain as visited
                if (this.redisClient) {
                    try {
                        const added = await this.redisClient.sadd(visitorKey, link.domain);
                        if (added === 1) {
                            const ttl = await this.redisClient.ttl(visitorKey);
                            if (ttl === -1) {
                                await this.redisClient.expire(visitorKey, 3600);
                            }
                        }
                    } catch (error) {
                        console.error(`[BEST_RPS] Error marking visited domain:`, error);
                    }
                }
                return {
                    url: link.url,
                    domain: link.domain,
                    linkId: `bestrps_${slug}_${link.domain}_${link.postId}`,
                    logType: `BEST_RPS #${i + 1} ${slug.toUpperCase()}`
                };
            }
        }

        // All domains exhausted — pick random domain with /random path
        const randomDomain = groupDomains[Math.floor(Math.random() * groupDomains.length)];
        return {
            url: `https://${randomDomain}${generateRandomPath()}`,
            domain: randomDomain,
            linkId: `bestrps_exhausted_${slug}_${randomDomain}`,
            logType: `BEST_RPS EXHAUSTED ${slug.toUpperCase()}`
        };
    }

    /**
     * Obtem o ranking de melhores links de um grupo pelo slug (com cache em memória + Redis)
     */
    private async getBestLinksMapForGroup(slug: string): Promise<RankedLinksList | null> {
        try {
            const now = Date.now();
            const cached = this.bestLinksMapCaches.get(slug);

            // Verificar cache em memória primeiro
            if (cached && (now - cached.time) < this.CACHE_TTL_MS) {
                return cached.data;
            }

            if (!this.redisClient) return cached?.data || null;

            const redisKey = this.getRedisKeyForGroup(slug);
            const redisData = await this.redisClient.get(redisKey);
            if (redisData) {
                const parsed = JSON.parse(redisData) as RankedLinksList;
                this.bestLinksMapCaches.set(slug, { data: parsed, time: now });
                return parsed;
            }
            return cached?.data || null;
        } catch (error) {
            console.error(`Error getting best links map for group ${slug}:`, error);
            return this.bestLinksMapCaches.get(slug)?.data || null;
        }
    }

    /**
     * Obtem o pool de exploração de um grupo pelo slug (com cache em memória + Redis).
     * Espelha `getBestLinksMapForGroup`. Só deve ser chamado quando a request já foi
     * decidida como exploração — evita pagar Redis extra nos 90% de requests normais.
     */
    private async getExplorationPoolForGroup(slug: string): Promise<RankedLinksList | null> {
        try {
            const now = Date.now();
            const cached = this.explorationPoolCaches.get(slug);

            if (cached && (now - cached.time) < this.CACHE_TTL_MS) {
                return cached.data;
            }

            if (!this.redisClient) return cached?.data || null;

            const redisKey = this.getRedisKeyForExplorationPool(slug);
            const redisData = await this.redisClient.get(redisKey);
            if (redisData) {
                const parsed = JSON.parse(redisData) as RankedLinksList;
                this.explorationPoolCaches.set(slug, { data: parsed, time: now });
                return parsed;
            }
            return cached?.data || null;
        } catch (error) {
            console.error(`Error getting exploration pool for group ${slug}:`, error);
            return this.explorationPoolCaches.get(slug)?.data || null;
        }
    }

    /**
     * Wrapper de compatibilidade: retorna ranking do grupo 'main'
     */
    private async getBestLinksMap(): Promise<RankedLinksList | null> {
        return this.getBestLinksMapForGroup('main');
    }

    /**
     * Wrapper de compatibilidade: retorna ranking do grupo 'db'
     */
    private async getBestLinksMapDb(): Promise<RankedLinksList | null> {
        return this.getBestLinksMapForGroup('db');
    }

    /**
     * Obtem as regras de redirecionamento do cache (com cache em memória)
     */
    private async getRules(): Promise<RedirectRule[]> {
        try {
            const now = Date.now();
            if (this.rulesCache && (now - this.rulesCacheTime) < this.CACHE_TTL_MS) {
                return this.rulesCache;
            }

            if (!this.redisClient) return this.rulesCache || [];

            const cached = await this.redisClient.get(this.REDIRECT_RULES_KEY);
            if (cached) {
                this.rulesCache = JSON.parse(cached) as RedirectRule[];
                this.rulesCacheTime = now;
                return this.rulesCache;
            }
            return [];
        } catch (error) {
            console.error('Error getting redirect rules:', error);
            return this.rulesCache || [];
        }
    }

    /**
     * Salva as regras no Redis e invalida o cache em memória
     */
    private async saveRules(rules: RedirectRule[]): Promise<void> {
        if (!this.redisClient) return;
        try {
            await this.redisClient.set(this.REDIRECT_RULES_KEY, JSON.stringify(rules));
            this.rulesCache = rules;
            this.rulesCacheTime = Date.now();
        } catch (err) {
            console.error('[REDIS] saveRules failed', err);
            throw err;
        }
    }

    /**
     * Verifica se uma requisição bate com alguma regra ativa
     */
    private matchRule(query: Record<string, any>, rules: RedirectRule[]): RedirectRule | null {
        for (const rule of rules) {
            if (!rule.active) continue;

            const allMatch = Object.entries(rule.conditions).every(
                ([key, value]) => String(query[key] || '') === value
            );

            if (allMatch) return rule;
        }
        return null;
    }

    /**
     * GET /api/rules — listar regras
     */
    public async listRules(_req: Request, res: Response): Promise<void> {
        try {
            const rules = await this.getRules();
            res.status(200).json({ rules });
        } catch (error) {
            console.error('Error listing rules:', error);
            res.status(500).json({ error: 'Failed to list rules' });
        }
    }

    /**
     * POST /api/rules — criar regra
     */
    public async createRule(req: Request, res: Response): Promise<void> {
        try {
            const { conditions, destination, passQueryParams, description } = req.body;

            if (!conditions || !destination) {
                res.status(400).json({ error: 'conditions e destination são obrigatórios' });
                return;
            }

            const rule: RedirectRule = {
                id: `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
                conditions,
                destination,
                passQueryParams: passQueryParams !== false,
                active: true,
                description: description || ''
            };

            const rules = await this.getRules();
            rules.push(rule);
            await this.saveRules(rules);

            console.log(`[RULE CREATED] ${rule.id}: ${JSON.stringify(rule.conditions)} -> ${rule.destination}`);
            res.status(201).json({ rule });
        } catch (error) {
            console.error('Error creating rule:', error);
            res.status(500).json({ error: 'Failed to create rule' });
        }
    }

    /**
     * DELETE /api/rules/:id — remover regra
     */
    public async deleteRule(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const rules = await this.getRules();
            const filtered = rules.filter(r => r.id !== id);

            if (filtered.length === rules.length) {
                res.status(404).json({ error: 'Rule not found' });
                return;
            }

            await this.saveRules(filtered);
            console.log(`[RULE DELETED] ${id}`);
            res.status(200).json({ message: 'Rule deleted' });
        } catch (error) {
            console.error('Error deleting rule:', error);
            res.status(500).json({ error: 'Failed to delete rule' });
        }
    }

    // ========== IN-APP RULES ==========

    /**
     * Detecta se o User-Agent é do navegador in-app do Facebook/Instagram
     */
    private isInAppBrowser(userAgent: string): boolean {
        return userAgent.includes('FBAN') || userAgent.includes('FBAV') ||
               userAgent.includes('Instagram');
    }

    /**
     * Gera HTML com iframe fullscreen apontando para a URL de destino
     */
    private generateIframeHtml(url: string): string {
        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Carregando...</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        html, body {
            width: 100%;
            height: 100%;
            overflow: hidden;
        }
        iframe {
            width: 100%;
            height: 100%;
            border: none;
            display: block;
        }
    </style>
</head>
<body>
    <iframe src="${url}" allowfullscreen></iframe>
</body>
</html>`;
    }

    /**
     * Repassa query params para uma URL de destino preservando string vazia e
     * sobrescrevendo (set) ao invés de duplicar (append) para evitar colisão
     * com params hardcoded no destination.
     */
    private forwardQueryParams(targetUrl: URL, query: Record<string, any>): void {
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null) continue;
            const v = Array.isArray(value) ? value[value.length - 1] : value;
            targetUrl.searchParams.set(key, String(v));
        }
    }

    /**
     * Obtem as regras de in-app do cache (com cache em memória)
     */
    private async getInAppRules(): Promise<InAppRule[]> {
        try {
            const now = Date.now();
            if (this.inAppRulesCache && (now - this.inAppRulesCacheTime) < this.CACHE_TTL_MS) {
                return this.inAppRulesCache;
            }

            if (!this.redisClient) return this.inAppRulesCache || [];

            const cached = await this.redisClient.get(this.INAPP_RULES_KEY);
            if (cached) {
                this.inAppRulesCache = JSON.parse(cached) as InAppRule[];
                this.inAppRulesCacheTime = now;
                return this.inAppRulesCache;
            }
            return [];
        } catch (error) {
            console.error('Error getting in-app rules:', error);
            return this.inAppRulesCache || [];
        }
    }

    /**
     * Salva as regras de in-app no Redis e invalida o cache
     */
    private async saveInAppRules(rules: InAppRule[]): Promise<void> {
        if (!this.redisClient) return;
        try {
            await this.redisClient.set(this.INAPP_RULES_KEY, JSON.stringify(rules));
            this.inAppRulesCache = rules;
            this.inAppRulesCacheTime = Date.now();
        } catch (err) {
            console.error('[REDIS] saveInAppRules failed', err);
            throw err;
        }
    }

    /**
     * GET /api/inapp-rules — listar regras de in-app
     */
    public async listInAppRules(_req: Request, res: Response): Promise<void> {
        try {
            const rules = await this.getInAppRules();
            res.status(200).json({ rules });
        } catch (error) {
            console.error('Error listing in-app rules:', error);
            res.status(500).json({ error: 'Failed to list in-app rules' });
        }
    }

    /**
     * POST /api/inapp-rules — criar regra de in-app
     * Body: { utm_campaign, destination, passQueryParams?, description? }
     */
    public async createInAppRule(req: Request, res: Response): Promise<void> {
        try {
            const { utm_campaign, destination, passQueryParams, description } = req.body;

            if (!utm_campaign || !destination) {
                res.status(400).json({ error: 'utm_campaign e destination são obrigatórios' });
                return;
            }

            const rule: InAppRule = {
                id: `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
                utm_campaign,
                destination,
                passQueryParams: passQueryParams !== false,
                active: true,
                description: description || ''
            };

            const rules = await this.getInAppRules();
            rules.push(rule);
            await this.saveInAppRules(rules);

            console.log(`[INAPP RULE CREATED] ${rule.id}: utm_campaign=${rule.utm_campaign} -> ${rule.destination}`);
            res.status(201).json({ rule });
        } catch (error) {
            console.error('Error creating in-app rule:', error);
            res.status(500).json({ error: 'Failed to create in-app rule' });
        }
    }

    /**
     * DELETE /api/inapp-rules/:id — remover regra de in-app
     */
    public async deleteInAppRule(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const rules = await this.getInAppRules();
            const filtered = rules.filter(r => r.id !== id);

            if (filtered.length === rules.length) {
                res.status(404).json({ error: 'In-app rule not found' });
                return;
            }

            await this.saveInAppRules(filtered);
            console.log(`[INAPP RULE DELETED] ${id}`);
            res.status(200).json({ message: 'In-app rule deleted' });
        } catch (error) {
            console.error('Error deleting in-app rule:', error);
            res.status(500).json({ error: 'Failed to delete in-app rule' });
        }
    }

    /**
     * Redirect principal com nova logica:
     * - Rotaciona dominios sequencialmente
     * - Se visitante ja viu o dominio naquela hora -> /random
     * - Se primeira visita -> melhor link do dominio
     */
    public async redirect(req: Request, res: Response): Promise<void> {
        try {
            if (req.path.includes('favicon') || req.url.includes('favicon')) {
                res.status(204).end();
                return;
            }

            // Verificar regras de redirecionamento condicional
            const rules = await this.getRules();
            const matchedRule = this.matchRule(req.query, rules);

            if (matchedRule) {
                const ruleUrl = new URL(matchedRule.destination);
                if (matchedRule.passQueryParams) {
                    this.forwardQueryParams(ruleUrl, req.query as Record<string, any>);
                }
                if (RedirectController.DEBUG_REDIRECT) console.log(`[RULE REDIRECT] ${matchedRule.id} (${matchedRule.description}) -> ${ruleUrl.toString()}`);
                res.setHeader('Cache-Control', 'private, no-store');
                res.redirect(ruleUrl.toString());
                return;
            }

            // Verificar regras de in-app/iframe
            // utm_campaign pode vir da query string OU do path (/:campaignId)
            const utmCampaign = (req.query.utm_campaign as string) || (req.params.campaignId as string);
            if (utmCampaign) {
                const inAppRules = await this.getInAppRules();
                const inAppMatch = inAppRules.find(r => r.active && r.utm_campaign === utmCampaign);

                if (inAppMatch) {
                    const inAppUrl = new URL(inAppMatch.destination);
                    if (inAppMatch.passQueryParams) {
                        this.forwardQueryParams(inAppUrl, req.query as Record<string, any>);
                        // Se veio do path, adicionar como utm_campaign
                        if (req.params.campaignId) {
                            inAppUrl.searchParams.append('utm_campaign', String(req.params.campaignId));
                        }
                    }
                    const finalUrl = inAppUrl.toString();
                    const userAgent = req.headers['user-agent'] || '';
                    const isInApp = this.isInAppBrowser(userAgent);

                    if (isInApp) {
                        // In-app (Facebook/Instagram) -> redirect para destino
                        if (RedirectController.DEBUG_REDIRECT) console.log(`[INAPP REDIRECT] ${inAppMatch.id} campaign=${utmCampaign} -> ${finalUrl}`);
                        res.setHeader('Cache-Control', 'private, no-store');
                        res.redirect(finalUrl);
                    } else {
                        // Não é in-app (Meta crawler, navegador normal) -> iframe
                        if (RedirectController.DEBUG_REDIRECT) console.log(`[IFRAME] ${inAppMatch.id} campaign=${utmCampaign} -> ${finalUrl}`);
                        res.send(this.generateIframeHtml(finalUrl));
                    }
                    return;
                }
            }

            // Identificar visitante por IP
            const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                           req.socket.remoteAddress || 'unknown';

            // Verificar idioma
            const language = req.query.language as string;

            // Buscar ranking global de links
            const globalRanking = await this.getBestLinksMap();

            let redirectUrl: string;
            let linkId: string;
            let logType: string;
            let domain: string;

            if (globalRanking && globalRanking.length > 0) {
                // groupConfig buscado ANTES da decisão de exploração (o service já cacheia) —
                // necessário para F3: em bestRpsMode, o domínio explorado precisa entrar no set
                // de visitados do IP, senão o rodízio por IP do getBestRpsLink perde coerência.
                const mainConfig = await this.domainGroupService.getGroupConfig('main');

                // Counter global por slug — chamado ANTES do branch de modo: a fatia de
                // exploração é ortogonal ao bestRpsMode e precisa do mesmo counter nos dois.
                // Tradeoff aceito conscientemente: grupos bestRpsMode passam a pagar 1 INCR
                // Redis por request (antes, zero) — necessário pra fatia valer nesse modo também.
                const visitIndex = await this.getGlobalVisitIndex('main');
                const explorationPool = isExplorationRequest(visitIndex, this.EXPLORATION_MOD)
                    ? await this.getExplorationPoolForGroup('main')
                    : null;
                const decision = decideServingSource(visitIndex, this.EXPLORATION_MOD, globalRanking.length, explorationPool?.length || 0);

                if (decision.source === 'pool' && explorationPool) {
                    const linkInfo = explorationPool[decision.index];
                    redirectUrl = linkInfo.url;
                    domain = linkInfo.domain;
                    linkId = `explore_main_${domain}_${linkInfo.postId}`;
                    logType = `EXPLORE #${decision.index + 1} MAIN`;

                    // F3: manter o rodízio por IP do bestRps coerente — o domínio explorado
                    // conta como visitado, senão o bestRps poderia reenviar o mesmo usuário
                    // pra lá logo em seguida. Fire-and-forget (mesmo padrão do resto do arquivo).
                    if (mainConfig?.bestRpsMode) {
                        this.addVisitedDomain(clientIp, 'main', domain).catch(() => {});
                    }
                } else if (mainConfig?.bestRpsMode) {
                    const mainDomains = await this.domainGroupService.getDomains('main');
                    const bestRps = await this.getBestRpsLink(clientIp, 'main', globalRanking, mainDomains);
                    redirectUrl = bestRps.url;
                    domain = bestRps.domain;
                    linkId = bestRps.linkId;
                    logType = bestRps.logType;
                } else {
                    // Pool ausente/vazio (ou fora da fatia de exploração) -> índice do ranking,
                    // já corrigido para não deixar slots sem tráfego (ver rankIndex() em
                    // utils/exploration-math.ts).
                    const idx = decision.index;
                    const linkInfo = globalRanking[idx];
                    redirectUrl = linkInfo.url;
                    domain = linkInfo.domain;
                    linkId = `rank${idx}_${domain}_${linkInfo.postId}`;
                    logType = `RANK #${idx + 1}`;
                }
            } else {
                // Sem dados de ranking -> dominio aleatorio + /random
                const mainDomains = await this.domainGroupService.getDomains('main');
                domain = mainDomains[Math.floor(Math.random() * mainDomains.length)];
                redirectUrl = `https://${domain}${generateRandomPath()}`;
                linkId = `fallback_${domain}`;
                logType = 'RANDOM LINK';
                if (RedirectController.DEBUG_REDIRECT) console.log(`[DEBUG] ranking global está VAZIO - rode /api/process para popular`);
            }

            /*
             * [DESATIVADO 2026-05-12] Inversão de idioma desligada por solicitação do produto.
             * Para reativar: descomentar este bloco (inclusive o log com langInfo abaixo).
             * Toda request passa direto ao redirectUrl sem prefixo de idioma.
             *
             * // Domínios com lógica invertida de idioma (APENAS estes recebem prefixo).
             * // Fast-path: extrair hostname por substring e checar Set antes de pagar new URL().
             * const hostStart = redirectUrl.indexOf('//');
             * let hostname = '';
             * if (hostStart !== -1) {
             *     const afterScheme = redirectUrl.slice(hostStart + 2);
             *     const pathStart = afterScheme.indexOf('/');
             *     hostname = pathStart === -1 ? afterScheme : afterScheme.slice(0, pathStart);
             *     const qIdx = hostname.indexOf('?');
             *     if (qIdx !== -1) hostname = hostname.slice(0, qIdx);
             *     hostname = hostname.toLowerCase();
             * }
             * const isInvertedDomain = RedirectController.INVERTED_LANG_DOMAINS.has(hostname);
             *
             * // Só adiciona prefixo de idioma nos domínios invertidos — todos os outros vão direto
             * if (isInvertedDomain) {
             *     const url = new URL(redirectUrl);
             *     if (!language || language === 'en') {
             *         url.pathname = `/en${url.pathname}`;
             *         redirectUrl = url.toString();
             *     } else if (language !== 'pt') {
             *         url.pathname = `/${language}${url.pathname}`;
             *         redirectUrl = url.toString();
             *     }
             *     // Se language=pt, nao adiciona nada (acesso direto)
             * }
             */

            // [DESATIVADO 2026-05-12] log de idioma removido junto com a inversão
            if (RedirectController.DEBUG_REDIRECT) {
                console.log(`[${logType}] ${domain} -> ${redirectUrl}`);
            }

            // Repassa TODOS os query params recebidos, com defaults para UTMs
            const allParams = new URLSearchParams();
            for (const [key, value] of Object.entries(req.query)) {
                if (value !== undefined && value !== null) {
                    allParams.set(key, String(value));
                }
            }
            // Defaults para UTMs caso nao tenham vindo na URL
            if (!allParams.has('utm_source')) allParams.set('utm_source', 'redron');
            if (!allParams.has('utm_medium')) allParams.set('utm_medium', 'broadcast');
            const broad = req.query.broad as string;
            if (broad) {
                allParams.set('utm_campaign', broad);
            } else if (!allParams.has('utm_campaign')) {
                allParams.set('utm_campaign', linkId || 'direct');
            }

            const separator = redirectUrl.includes('?') ? '&' : '?';
            const finalRedirectUrl = `${redirectUrl}${separator}${allParams.toString()}`;

            // Registrar click (fire-and-forget, sem log per-request)
            if (linkId && this.redirectClickRepository) {
                this.redirectClickRepository.incrementClick(linkId).catch(() => {});
            }
            if (broad && this.broadClickRepository) {
                this.broadClickRepository.incrementClick(broad).catch(() => {});
            }

            res.setHeader('Cache-Control', 'private, no-store');
            res.redirect(finalRedirectUrl);
        } catch (error) {
            console.error('Error in redirect:', error);
            res.setHeader('Cache-Control', 'private, no-store');
            res.redirect('https://useuapp.com/random');
        }
    }

    /**
     * Redirect generico para qualquer grupo de dominios (rotas dinamicas).
     * Usa ranking eCPM do grupo, com fallback para dominio aleatorio + /random.
     */
    public async redirectByGroup(req: Request, res: Response, slug: string): Promise<void> {
        try {
            if (req.path.includes('favicon') || req.url.includes('favicon')) {
                res.status(204).end();
                return;
            }

            const groupDomains = await this.domainGroupService.getDomains(slug);
            if (groupDomains.length === 0) {
                res.status(503).json({ error: `No domains configured for group "${slug}"` });
                return;
            }

            // Verificar regras de in-app/iframe
            const utmCampaign = (req.query.utm_campaign as string) || (req.params.campaignId as string);
            if (utmCampaign) {
                const inAppRules = await this.getInAppRules();
                const inAppMatch = inAppRules.find(r => r.active && r.utm_campaign === utmCampaign);

                if (inAppMatch) {
                    const inAppUrl = new URL(inAppMatch.destination);
                    if (inAppMatch.passQueryParams) {
                        this.forwardQueryParams(inAppUrl, req.query as Record<string, any>);
                        if (req.params.campaignId) {
                            inAppUrl.searchParams.append('utm_campaign', String(req.params.campaignId));
                        }
                    }
                    const finalUrl = inAppUrl.toString();
                    const userAgent = req.headers['user-agent'] || '';
                    const isInApp = this.isInAppBrowser(userAgent);

                    if (isInApp) {
                        if (RedirectController.DEBUG_REDIRECT) console.log(`[INAPP REDIRECT ${slug.toUpperCase()}] ${inAppMatch.id} campaign=${utmCampaign} -> ${finalUrl}`);
                        res.setHeader('Cache-Control', 'private, no-store');
                        res.redirect(finalUrl);
                    } else {
                        if (RedirectController.DEBUG_REDIRECT) console.log(`[IFRAME ${slug.toUpperCase()}] ${inAppMatch.id} campaign=${utmCampaign} -> ${finalUrl}`);
                        res.send(this.generateIframeHtml(finalUrl));
                    }
                    return;
                }
            }

            // Identificar visitante por IP
            const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                           req.socket.remoteAddress || 'unknown';

            // Buscar ranking global de links do grupo
            const globalRanking = await this.getBestLinksMapForGroup(slug);

            let redirectUrl: string;
            let linkId: string;
            let logType: string;
            let domain: string;

            if (globalRanking && globalRanking.length > 0) {
                // groupConfig buscado ANTES da decisão de exploração (o service já cacheia) —
                // necessário para F3: em bestRpsMode, o domínio explorado precisa entrar no set
                // de visitados do IP, senão o rodízio por IP do getBestRpsLink perde coerência.
                const groupConfig = await this.domainGroupService.getGroupConfig(slug);

                // Counter global por slug — chamado ANTES do branch de modo: a fatia de
                // exploração é ortogonal ao bestRpsMode e precisa do mesmo counter nos dois.
                // Tradeoff aceito conscientemente: grupos bestRpsMode passam a pagar 1 INCR
                // Redis por request (antes, zero) — necessário pra fatia valer nesse modo também.
                const visitIndex = await this.getGlobalVisitIndex(slug);
                const explorationPool = isExplorationRequest(visitIndex, this.EXPLORATION_MOD)
                    ? await this.getExplorationPoolForGroup(slug)
                    : null;
                const decision = decideServingSource(visitIndex, this.EXPLORATION_MOD, globalRanking.length, explorationPool?.length || 0);

                if (decision.source === 'pool' && explorationPool) {
                    const linkInfo = explorationPool[decision.index];
                    redirectUrl = linkInfo.url;
                    domain = linkInfo.domain;
                    linkId = `explore_${slug}_${domain}_${linkInfo.postId}`;
                    logType = `EXPLORE #${decision.index + 1} ${slug.toUpperCase()}`;

                    // F3: manter o rodízio por IP do bestRps coerente — o domínio explorado
                    // conta como visitado, senão o bestRps poderia reenviar o mesmo usuário
                    // pra lá logo em seguida. Fire-and-forget (mesmo padrão do resto do arquivo).
                    if (groupConfig?.bestRpsMode) {
                        this.addVisitedDomain(clientIp, slug, domain).catch(() => {});
                    }
                } else if (groupConfig?.bestRpsMode) {
                    const bestRps = await this.getBestRpsLink(clientIp, slug, globalRanking, groupDomains);
                    redirectUrl = bestRps.url;
                    domain = bestRps.domain;
                    linkId = bestRps.linkId;
                    logType = bestRps.logType;
                } else {
                    // Pool ausente/vazio (ou fora da fatia de exploração) -> índice do ranking,
                    // já corrigido para não deixar slots sem tráfego (ver rankIndex() em
                    // utils/exploration-math.ts).
                    const idx = decision.index;
                    const linkInfo = globalRanking[idx];
                    redirectUrl = linkInfo.url;
                    domain = linkInfo.domain;
                    linkId = `rank${idx}_${slug}_${domain}_${linkInfo.postId}`;
                    logType = `RANK #${idx + 1} ${slug.toUpperCase()}`;
                }
            } else {
                // Sem dados de ranking -> dominio aleatorio + /random
                domain = groupDomains[Math.floor(Math.random() * groupDomains.length)];
                redirectUrl = `https://${domain}${generateRandomPath()}`;
                linkId = `fallback_${slug}_${domain}`;
                logType = `RANDOM LINK ${slug.toUpperCase()}`;
                if (RedirectController.DEBUG_REDIRECT) console.log(`[DEBUG-${slug.toUpperCase()}] ranking global está VAZIO - rode /api/process para popular`);
            }

            // Log (gated por DEBUG_REDIRECT)
            if (RedirectController.DEBUG_REDIRECT) {
                console.log(`[${logType}] ${domain} -> ${redirectUrl}`);
            }

            // Repassa TODOS os query params recebidos, com defaults para UTMs
            const allParams = new URLSearchParams();
            for (const [key, value] of Object.entries(req.query)) {
                if (value !== undefined && value !== null) {
                    allParams.set(key, String(value));
                }
            }
            // Defaults para UTMs caso nao tenham vindo na URL
            if (!allParams.has('utm_source')) allParams.set('utm_source', 'redron');
            if (!allParams.has('utm_medium')) allParams.set('utm_medium', 'broadcast');
            const broad = req.query.broad as string;
            if (broad) {
                allParams.set('utm_campaign', broad);
            } else if (!allParams.has('utm_campaign')) {
                allParams.set('utm_campaign', linkId || 'direct');
            }

            const separator = redirectUrl.includes('?') ? '&' : '?';
            const finalRedirectUrl = `${redirectUrl}${separator}${allParams.toString()}`;

            // Registrar click (fire-and-forget, sem log per-request)
            if (linkId && this.redirectClickRepository) {
                this.redirectClickRepository.incrementClick(linkId).catch(() => {});
            }
            if (broad && this.broadClickRepository) {
                this.broadClickRepository.incrementClick(broad).catch(() => {});
            }

            res.setHeader('Cache-Control', 'private, no-store');
            res.redirect(finalRedirectUrl);
        } catch (error) {
            console.error(`Error in redirectByGroup(${slug}):`, error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    public async getRank(req: Request, res: Response): Promise<void> {
        try {
            if (!this.redirectClickRepository) {
                res.status(503).json({ error: 'Database not connected' });
                return;
            }

            const sortBy = (req.query.sort as string) || 'clicks';
            const limit = parseInt(req.query.limit as string) || 100;

            const [mainRanking, dbRanking] = await Promise.all([
                this.getBestLinksMap(),
                this.getBestLinksMapDb()
            ]);

            const buildRankResult = async (ranking: RankedLinksList | null) => {
                if (!ranking || ranking.length === 0) return { rank: [], total: 0 };

                const suffixSet = new Set<string>();
                for (const item of ranking) {
                    suffixSet.add(`${item.domain}_${item.postId}`);
                }
                const clickCountsMap = await this.redirectClickRepository!.getClickCountsBySuffixes(Array.from(suffixSet));

                const result = ranking.map(item => {
                    const suffix = `${item.domain}_${item.postId}`;
                    return {
                        url: item.url,
                        domain: item.domain,
                        postId: item.postId,
                        ecpm: item.ecpm,
                        clickCount: clickCountsMap.get(suffix) || 0
                    };
                });

                if (sortBy === 'ecpm') {
                    result.sort((a, b) => b.ecpm - a.ecpm);
                } else {
                    result.sort((a, b) => b.clickCount - a.clickCount);
                }

                return { rank: result.slice(0, limit), total: result.length };
            };

            const [mainResult, dbResult] = await Promise.all([
                buildRankResult(mainRanking),
                buildRankResult(dbRanking)
            ]);

            res.status(200).json({
                sort: sortBy,
                main: mainResult,
                db: dbResult
            });
        } catch (error) {
            console.error('Error getting rank:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: 'Failed to get rank'
            });
        }
    }

    public async getBroadClicks(req: Request, res: Response): Promise<void> {
        try {
            if (!this.broadClickRepository) {
                res.status(500).json({ error: 'Database not available' });
                return;
            }

            const start = req.query.start as string | undefined;
            const end = req.query.end as string | undefined;

            const clicks = await this.broadClickRepository.getClicks(start, end);
            res.json(clicks);
        } catch (error) {
            console.error('[ERROR] getBroadClicks:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    public async getRankByDomain(_req: Request, res: Response): Promise<void> {
        try {
            const [mainRanking, dbRanking] = await Promise.all([
                this.getBestLinksMap(),
                this.getBestLinksMapDb()
            ]);

            const groupByDomain = (ranking: RankedLinksList | null, source: string) => {
                if (!ranking) return {};
                const grouped: Record<string, Array<{ position: number; postId: string; url: string; ecpm: number; source: string }>> = {};
                ranking.forEach((link, index) => {
                    if (!grouped[link.domain]) grouped[link.domain] = [];
                    grouped[link.domain].push({
                        position: index + 1,
                        postId: link.postId,
                        url: link.url,
                        ecpm: link.ecpm,
                        source
                    });
                });
                return grouped;
            };

            const mainGrouped = groupByDomain(mainRanking, 'main');
            const dbGrouped = groupByDomain(dbRanking, 'db');

            res.json({
                main: {
                    total_links: mainRanking?.length || 0,
                    domains: Object.keys(mainGrouped).length,
                    by_domain: mainGrouped
                },
                db: {
                    total_links: dbRanking?.length || 0,
                    domains: Object.keys(dbGrouped).length,
                    by_domain: dbGrouped
                }
            });
        } catch (error) {
            console.error('[ERROR] getRankByDomain:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    public async getStats(req: Request, res: Response): Promise<void> {
        try {
            if (!this.gamAdUnitRepository || !this.redirectClickRepository) {
                res.status(503).json({ error: 'Database not connected' });
                return;
            }

            const query = {
                start: req.query.start as string | undefined,
                end: req.query.end as string | undefined,
                domain: req.query.domain as string | string[] | undefined,
                network: req.query.network as string | undefined,
                country: req.query.country as string | undefined
            };

            const gamStats = await this.gamAdUnitRepository.getStats(query);
            const clickStats = await this.redirectClickRepository.getStats();
            const globalRanking = await this.getBestLinksMap();
            const globalRankingDb = await this.getBestLinksMapDb();

            res.status(200).json({
                gam: gamStats,
                clicks: clickStats,
                traffic: {
                    totalDomains: (await this.domainGroupService.getDomains('main')).length,
                    totalDomainsDb: (await this.domainGroupService.getDomains('db')).length,
                    globalRanking: globalRanking,
                    globalRankingDb: globalRankingDb
                }
            });
        } catch (error) {
            console.error('Error getting stats:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: 'Failed to get statistics'
            });
        }
    }

    public async getDistinctValues(req: Request, res: Response): Promise<void> {
        try {
            if (!this.gamAdUnitRepository) {
                res.status(503).json({ error: 'Database not connected' });
                return;
            }

            const field = req.params.field as any;
            const validFields = ['domain', 'network', 'country', 'custom_key', 'custom_value', 'ad_unit_name'];

            if (!validFields.includes(field)) {
                res.status(400).json({ error: 'Invalid field', validFields });
                return;
            }

            const query = {
                start: req.query.start as string | undefined,
                end: req.query.end as string | undefined
            };

            const values = await this.gamAdUnitRepository.getDistinctValues(field, query);
            res.status(200).json({ field, values });
        } catch (error) {
            console.error('Error getting distinct values:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: 'Failed to get distinct values'
            });
        }
    }

    public async getRedirectLinks(req: Request, res: Response): Promise<void> {
        try {
            if (!this.redirectLinkRepository) {
                res.status(503).json({ error: 'Database not connected' });
                return;
            }

            const limit = parseInt(req.query.limit as string) || 100;
            const offset = parseInt(req.query.offset as string) || 0;
            const domain = req.query.domain as string | undefined;

            let links;
            if (domain) {
                links = await this.redirectLinkRepository.getLinksByDomain(domain);
            } else {
                links = await this.redirectLinkRepository.getAllLinks(limit, offset);
            }

            const totalCount = await this.redirectLinkRepository.countLinks();

            res.status(200).json({
                links,
                total: totalCount,
                limit,
                offset
            });
        } catch (error) {
            console.error('Error getting redirect links:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: 'Failed to get redirect links'
            });
        }
    }
}
