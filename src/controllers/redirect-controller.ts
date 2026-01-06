import { Request, Response } from 'express';
import { Db } from 'mongodb';
import * as cron from 'node-cron';
import cluster from 'cluster';
import { SuperFilterService } from '../services/superfilter-service';
import { GamAdUnitRepository } from '../repositories/gam-ad-unit-repository';
import { RedirectLinkRepository } from '../repositories/redirect-link-repository';
import { RedirectClickRepository } from '../repositories/redirect-click-repository';
import { IFilterRequest } from '../interfaces/filter-interfaces';
import { redis } from '../config/redis';
import { generateRandomPath, domains } from '../config/domains';

/**
 * Interface para o mapa de melhores links por dominio
 */
interface BestLinkMap {
    [domain: string]: {
        url: string;
        postId: string;
        ecpm: number;
    };
}

/**
 * Interface para domínios ordenados por eCPM
 */
interface SortedDomain {
    domain: string;
    url: string;
    postId: string;
    ecpm: number;
}

export class RedirectController {
    private superFilterService: SuperFilterService;
    private gamAdUnitRepository?: GamAdUnitRepository;
    private redirectLinkRepository?: RedirectLinkRepository;
    private redirectClickRepository?: RedirectClickRepository;
    private redisClient: typeof redis | null;

    // Chaves Redis
    private readonly DOMAIN_COUNTER_KEY = 'redirect:domain:counter';
    private readonly BEST_LINKS_MAP_KEY = 'redirect:best_links_map';
    private readonly SORTED_DOMAINS_KEY = 'redirect:sorted_domains';
    private readonly VISITOR_PREFIX = 'visitor';

    // Cache em memória para evitar chamadas repetidas ao Redis
    private bestLinksMapCache: BestLinkMap | null = null;
    private bestLinksMapCacheTime: number = 0;
    private sortedDomainsCache: SortedDomain[] | null = null;
    private sortedDomainsCacheTime: number = 0;
    private readonly CACHE_TTL_MS = 60000; // 1 minuto de cache em memória

    constructor(db?: Db) {
        this.superFilterService = new SuperFilterService();
        this.redisClient = redis;

        if (db) {
            this.gamAdUnitRepository = new GamAdUnitRepository(db);
            this.redirectLinkRepository = new RedirectLinkRepository(db);
            this.redirectClickRepository = new RedirectClickRepository(db);
        }

        const isMainProcess = !cluster.isWorker || cluster.worker?.id === 1;
        if (isMainProcess) {
            this.initializeScheduledProcess();
        }
    }

    /**
     * Cron: minuto 30 de cada hora - busca melhor eCPM de CADA dominio
     */
    private initializeScheduledProcess(): void {
        console.log('[CRON] Inicializando agendamento - executará no minuto 30 de cada hora');

        // Executar imediatamente na inicialização para popular o cache
        this.executeProcessInternal()
            .then(() => console.log('[CRON] Cache inicial populado com sucesso'))
            .catch(err => console.error('[CRON] Erro ao popular cache inicial:', err));

        // Agendar para rodar no minuto 30
        const task = cron.schedule('30 * * * *', async () => {
            console.log('[CRON] Executando atualização agendada...');
            try {
                await this.executeProcessInternal();
            } catch (error) {
                console.error('[CRON] Erro:', error);
            }
        });
        task.start();
    }

    /**
     * Busca em TODOS os dominios o melhor post (maior eCPM) de CADA dominio
     * Salva no Redis e atualiza o MongoDB (desativa antigos, ativa novos)
     */
    private async executeProcessInternal(): Promise<BestLinkMap | null> {
        const date = new Date();
        const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());

        const filterRequest: IFilterRequest = {
            start: today.toISOString().split('T')[0],
            end: today.toISOString().split('T')[0],
            domain: domains,
            custom_key: "id_post_wp",
            group: ["domain", "custom_key", "custom_value"]
        };

        if (!this.gamAdUnitRepository) {
            throw new Error('Database not connected');
        }

        const data = await this.superFilterService.execute(filterRequest, this.gamAdUnitRepository);

        if (!Array.isArray(data) || data.length === 0) {
            console.log('[CRON] Nenhum dado encontrado para processar');
            return null;
        }

        // Agrupar por dominio e pegar o melhor de cada
        const bestByDomain: BestLinkMap = {};

        for (const item of data) {
            if (!item.domain || !item.custom_value) continue;

            const domain = item.domain as string;
            const ecpm = parseFloat(String(item.ecpm || 0));
            const postId = String(item.custom_value);

            // Se ainda nao temos esse dominio ou este tem eCPM maior
            if (!bestByDomain[domain] || ecpm > bestByDomain[domain].ecpm) {
                bestByDomain[domain] = {
                    url: `https://${domain}/?p=${encodeURIComponent(postId)}`,
                    postId: postId,
                    ecpm: ecpm
                };
            }
        }

        // Salvar no cache Redis (1 hora)
        if (this.redisClient && Object.keys(bestByDomain).length > 0) {
            await this.redisClient.set(
                this.BEST_LINKS_MAP_KEY,
                JSON.stringify(bestByDomain),
                'EX',
                3600
            );
            // Atualizar cache em memória também
            this.bestLinksMapCache = bestByDomain;
            this.bestLinksMapCacheTime = Date.now();

            // Criar lista ordenada por eCPM (maior primeiro)
            const sortedDomains: SortedDomain[] = Object.entries(bestByDomain)
                .map(([domain, info]) => ({
                    domain,
                    url: info.url,
                    postId: info.postId,
                    ecpm: info.ecpm
                }))
                .sort((a, b) => b.ecpm - a.ecpm);

            // Salvar lista ordenada no Redis
            await this.redisClient.set(
                this.SORTED_DOMAINS_KEY,
                JSON.stringify(sortedDomains),
                'EX',
                3600
            );
            this.sortedDomainsCache = sortedDomains;
            this.sortedDomainsCacheTime = Date.now();

            console.log(`[CRON] Mapa de melhores links atualizado: ${Object.keys(bestByDomain).length} dominios`);
            console.log(`[CRON] Ordem por eCPM: ${sortedDomains.map(d => `${d.domain}(${d.ecpm.toFixed(2)})`).join(' > ')}`);
        }

        // Atualizar MongoDB: desativar todos e ativar apenas os melhores
        if (this.redirectLinkRepository) {
            try {
                // 1. Desativar TODOS os links ativos
                const allLinks = await this.redirectLinkRepository.getAllLinks(1000, 0);
                for (const link of allLinks) {
                    if (link._id && link.status === true) {
                        await this.redirectLinkRepository.updateLink(link._id.toString(), { status: false });
                    }
                }

                // 2. Ativar ou criar apenas os melhores de cada domínio
                for (const [domain, info] of Object.entries(bestByDomain)) {
                    const existing = await this.redirectLinkRepository.getLinkByDomainAndUrl(domain, info.url);
                    if (existing && existing._id) {
                        await this.redirectLinkRepository.updateLink(existing._id.toString(), { status: true });
                    } else {
                        await this.redirectLinkRepository.createLink({
                            domain: domain,
                            url: info.url,
                            status: true
                        });
                    }
                }
                console.log(`[CRON] MongoDB atualizado: ${Object.keys(bestByDomain).length} links ativos`);
            } catch (error) {
                console.error('[CRON] Erro ao atualizar MongoDB:', error);
            }
        }

        // Log dos melhores links
        for (const [domain, info] of Object.entries(bestByDomain)) {
            console.log(`[CRON] ${domain} -> p=${info.postId} (eCPM: ${info.ecpm.toFixed(4)})`);
        }

        return bestByDomain;
    }

    /**
     * Endpoint manual: GET /api/process
     */
    public async process(_req: Request, res: Response): Promise<void> {
        try {
            const data = await this.executeProcessInternal();
            res.status(200).json({
                success: true,
                message: 'Process executado - melhores links por dominio encontrados',
                data: data
            });
        } catch (error) {
            console.error('Error processing filter:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }

    /**
     * Gera a chave para contar quantos domínios o visitante já viu nesta hora
     * Formato: visitor_count:{ip}:{hora}
     */
    private getVisitorCountKey(ip: string): string {
        const hour = new Date().getHours();
        return `${this.VISITOR_PREFIX}_count:${ip}:${hour}`;
    }

    /**
     * Obtém e incrementa o contador de domínios visitados pelo usuário nesta hora
     * Retorna o número do próximo domínio a visitar (1, 2, 3... até domains.length, depois continua incrementando)
     */
    private async getAndIncrementVisitorDomainCount(ip: string): Promise<number> {
        if (!this.redisClient) return 1;

        try {
            const key = this.getVisitorCountKey(ip);
            const count = await this.redisClient.incr(key);

            // Definir TTL de 1 hora apenas na primeira vez
            if (count === 1) {
                await this.redisClient.expire(key, 3600);
            }

            return count;
        } catch (error) {
            return 1;
        }
    }

    /**
     * Obtem o proximo dominio na rotacao sequencial (global, para o /random)
     */
    private async getNextRandomDomain(): Promise<string> {
        try {
            const counter = await redis.incr(this.DOMAIN_COUNTER_KEY);
            const index = (counter - 1) % domains.length;
            return domains[index];
        } catch (error) {
            return domains[Math.floor(Math.random() * domains.length)];
        }
    }

    /**
     * Obtem o mapa de melhores links do cache (com cache em memória)
     */
    private async getBestLinksMap(): Promise<BestLinkMap | null> {
        try {
            // Verificar cache em memória primeiro
            const now = Date.now();
            if (this.bestLinksMapCache && (now - this.bestLinksMapCacheTime) < this.CACHE_TTL_MS) {
                return this.bestLinksMapCache;
            }

            if (!this.redisClient) return this.bestLinksMapCache;

            const cached = await this.redisClient.get(this.BEST_LINKS_MAP_KEY);
            if (cached) {
                this.bestLinksMapCache = JSON.parse(cached) as BestLinkMap;
                this.bestLinksMapCacheTime = now;
                return this.bestLinksMapCache;
            }
            return this.bestLinksMapCache;
        } catch (error) {
            console.error('Error getting best links map:', error);
            return this.bestLinksMapCache;
        }
    }

    /**
     * Obtem a lista de dominios ordenados por eCPM (maior primeiro)
     */
    private async getSortedDomains(): Promise<SortedDomain[]> {
        try {
            // Verificar cache em memória primeiro
            const now = Date.now();
            if (this.sortedDomainsCache && this.sortedDomainsCache.length > 0 && (now - this.sortedDomainsCacheTime) < this.CACHE_TTL_MS) {
                return this.sortedDomainsCache;
            }

            if (!this.redisClient) return this.sortedDomainsCache || [];

            const cached = await this.redisClient.get(this.SORTED_DOMAINS_KEY);
            if (cached) {
                this.sortedDomainsCache = JSON.parse(cached) as SortedDomain[];
                this.sortedDomainsCacheTime = now;
                return this.sortedDomainsCache;
            }
            return this.sortedDomainsCache || [];
        } catch (error) {
            console.error('Error getting sorted domains:', error);
            return this.sortedDomainsCache || [];
        }
    }

    /**
     * Redirect principal com nova logica:
     * - Sempre envia para o melhor eCPM
     * - Cada visita do mesmo usuário vai para o próximo domínio
     * - Quando acabar todos os domínios, usa /random
     */
    public async redirect(req: Request, res: Response): Promise<void> {
        try {
            if (req.path.includes('favicon') || req.url.includes('favicon')) {
                res.status(204).end();
                return;
            }

            // Identificar visitante por IP
            const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                           req.socket.remoteAddress || 'unknown';

            // Verificar idioma
            const language = req.query.language as string;

            // Obter qual visita é essa do usuário nesta hora (1, 2, 3...)
            const visitNumber = await this.getAndIncrementVisitorDomainCount(clientIp);

            let redirectUrl: string;
            let linkId: string;
            let logType: string;
            let domain: string;

            // Obter lista de domínios ordenados por eCPM (maior primeiro)
            const sortedDomains = await this.getSortedDomains();

            // Se ainda não visitou todos os domínios, usa o próximo na ordem de eCPM
            if (sortedDomains.length > 0 && visitNumber <= sortedDomains.length) {
                // Pegar o domínio baseado no número da visita ordenado por eCPM
                // visita 1 = maior eCPM, visita 2 = segundo maior, etc
                const sortedDomain = sortedDomains[visitNumber - 1];
                domain = sortedDomain.domain;
                redirectUrl = sortedDomain.url;
                linkId = `best_${domain}_${sortedDomain.postId}`;
                logType = 'BEST LINK';
            } else if (sortedDomains.length === 0 && visitNumber <= domains.length) {
                // Fallback se não tiver dados ordenados: usa ordem fixa
                domain = domains[visitNumber - 1];
                const bestLinksMap = await this.getBestLinksMap();
                const bestLinkInfo = bestLinksMap?.[domain];

                if (bestLinkInfo) {
                    redirectUrl = bestLinkInfo.url;
                    linkId = `best_${domain}_${bestLinkInfo.postId}`;
                    logType = 'BEST LINK';
                } else {
                    redirectUrl = `https://${domain}${generateRandomPath()}`;
                    linkId = `fallback_${domain}`;
                    logType = 'RANDOM LINK';
                    console.log(`[DEBUG] sortedDomains e bestLinksMap vazios - rode /api/process para popular`);
                }
            } else {
                // Já visitou todos os domínios, agora usa /random rotacionando
                domain = await this.getNextRandomDomain();
                redirectUrl = `https://${domain}${generateRandomPath()}`;
                linkId = `random_${domain}`;
                logType = 'RANDOM LINK';
            }

            // Dominios com logica invertida de idioma
            const invertedLangDomains = ['appmobile4u.com', 'appcombos.com', 'informanoticia.com', 'buscaapp.com.br', 'lavoriinitalia.com', 'cincosete.com'];
            const url = new URL(redirectUrl);
            const isInvertedDomain = invertedLangDomains.some(d => url.hostname.includes(d));

            // Adicionar prefixo de idioma
            if (isInvertedDomain) {
                // Para dominios invertidos: sem language = /en/, com pt = direto
                if (!language || language === 'en') {
                    url.pathname = `/en${url.pathname}`;
                    redirectUrl = url.toString();
                } else if (language !== 'pt') {
                    // Outros idiomas (es, fr, it, etc) adiciona o prefixo
                    url.pathname = `/${language}${url.pathname}`;
                    redirectUrl = url.toString();
                }
                // Se language=pt, nao adiciona nada (acesso direto)
            } else {
                // Dominios normais: so adiciona prefixo se tiver language
                if (language) {
                    url.pathname = `/${language}${url.pathname}`;
                    redirectUrl = url.toString();
                }
            }

            // Log com informacao de idioma, dominio e eCPM
            const langInfo = language ? ` [${language.toUpperCase()}]` : (isInvertedDomain ? ' [EN]' : '');
            const totalDomains = sortedDomains.length > 0 ? sortedDomains.length : domains.length;
            const visitInfo = visitNumber <= totalDomains ? ` (visita ${visitNumber}/${totalDomains})` : ' (extra)';
            const ecpmInfo = sortedDomains.length > 0 && visitNumber <= sortedDomains.length
                ? ` eCPM:${sortedDomains[visitNumber - 1].ecpm.toFixed(2)}`
                : '';
            console.log(`[${logType}]${langInfo}${ecpmInfo} ${domain}${visitInfo} -> ${redirectUrl}`);

            // UTM params
            const utmParams = new URLSearchParams();
            utmParams.append('utm_source', (req.query.utm_source as string) || 'redron');
            utmParams.append('utm_medium', (req.query.utm_medium as string) || 'broadcast');
            utmParams.append('utm_campaign', (req.query.utm_campaign as string) || linkId || 'direct');
            if (req.query.utm_term) utmParams.append('utm_term', req.query.utm_term as string);
            if (req.query.utm_content) utmParams.append('utm_content', req.query.utm_content as string);
            if (req.query.fbclid) utmParams.append('fbclid', req.query.fbclid as string);
            if (req.query.gclid) utmParams.append('gclid', req.query.gclid as string);

            const separator = redirectUrl.includes('?') ? '&' : '?';
            const finalRedirectUrl = `${redirectUrl}${separator}${utmParams.toString()}`;

            // Registrar click
            if (linkId && this.redirectClickRepository) {
                this.redirectClickRepository.incrementClick(linkId)
                    .then(result => console.log(`[CLICK RECORDED] LinkID: ${linkId}, New Count: ${result.count}`))
                    .catch(() => {});
            }

            // Cache anti-duplicacao (fire and forget)
            if (this.redisClient) {
                this.redisClient.set(`recent:${clientIp}`, finalRedirectUrl, 'EX', 5).catch(() => {});
            }

            res.redirect(finalRedirectUrl);
        } catch (error) {
            console.error('Error in redirect:', error);
            res.redirect('https://useuapp.com/random');
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
            const currentCounter = await redis.get(this.DOMAIN_COUNTER_KEY) || '0';
            const bestLinksMap = await this.getBestLinksMap();

            res.status(200).json({
                gam: gamStats,
                clicks: clickStats,
                traffic: {
                    currentDomainCounter: parseInt(currentCounter),
                    totalDomains: domains.length,
                    currentDomainIndex: (parseInt(currentCounter) - 1) % domains.length,
                    bestLinksMap: bestLinksMap
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
