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

export class RedirectController {
    private superFilterService: SuperFilterService;
    private gamAdUnitRepository?: GamAdUnitRepository;
    private redirectLinkRepository?: RedirectLinkRepository;
    private redirectClickRepository?: RedirectClickRepository;
    private redisClient: typeof redis | null;

    private readonly TRAFFIC_DISTRIBUTION = {
        PRIMARY: 6,  // 60% do tráfego vai para o melhor link
        FALLBACK: 4  // 40% do tráfego vai para domínios /random
    };
    private readonly COUNTER_KEY = 'redirect:traffic:counter';
    private readonly FALLBACK_COUNTER_KEY = 'redirect:fallback:counter';
    private readonly BEST_LINK_CACHE_KEY = 'redirect:best_link';

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
     * Cron: minuto 30 de cada hora - busca melhor eCPM geral
     */
    private initializeScheduledProcess(): void {
        const task = cron.schedule('30 * * * *', async () => {
            try {
                await this.executeProcessInternal();
            } catch (error) {
                console.error('[CRON] Erro:', error);
            }
        });
        task.start();
    }

    /**
     * Busca em TODOS os domínios o post com maior eCPM e salva no cache
     */
    private async executeProcessInternal(): Promise<any> {
        const date = new Date();
        const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());

        const filterRequest: IFilterRequest = {
            start: today.toISOString().split('T')[0],
            end: today.toISOString().split('T')[0],
            domain: domains, // TODOS os domínios
            custom_key: "id_post_wp",
            group: ["domain", "custom_key", "custom_value"]
        };

        if (!this.gamAdUnitRepository) {
            throw new Error('Database not connected');
        }

        let data = await this.superFilterService.execute(filterRequest, this.gamAdUnitRepository);

        if (Array.isArray(data) && data.length > 0) {
            // Ordenar por eCPM e pegar o MELHOR de todos os domínios
            const sorted = data.sort((a, b) => {
                const ecpmA = parseFloat(String(a.ecpm || 0));
                const ecpmB = parseFloat(String(b.ecpm || 0));
                return ecpmB - ecpmA;
            });

            const best = sorted[0];
            if (best.domain && best.custom_value) {
                const bestLink = {
                    url: `https://${best.domain}/?p=${encodeURIComponent(String(best.custom_value))}`,
                    domain: best.domain,
                    ecpm: best.ecpm
                };

                // Salvar no cache Redis (1 hora)
                if (this.redisClient) {
                    await this.redisClient.set(this.BEST_LINK_CACHE_KEY, JSON.stringify(bestLink), 'EX', 3600);
                }

                // Atualizar no banco também
                if (this.redirectLinkRepository) {
                    await this.updateBestLink(bestLink);
                }

                return bestLink;
            }
        }

        return null;
    }

    /**
     * Atualiza o link no banco de dados
     */
    private async updateBestLink(bestLink: { url: string; domain: string }): Promise<void> {
        if (!this.redirectLinkRepository) return;

        try {
            // Desativar todos os links
            const allLinks = await this.redirectLinkRepository.getAllLinks(1000, 0);
            for (const link of allLinks) {
                if (link._id && link.status) {
                    await this.redirectLinkRepository.updateLink(link._id.toString(), { status: false });
                }
            }

            // Ativar ou criar o melhor link
            const existing = await this.redirectLinkRepository.getLinkByDomainAndUrl(bestLink.domain, bestLink.url);
            if (existing && existing._id) {
                await this.redirectLinkRepository.updateLink(existing._id.toString(), { status: true });
            } else {
                await this.redirectLinkRepository.createLink({
                    domain: bestLink.domain,
                    url: bestLink.url,
                    status: true
                });
            }
        } catch (error) {
            console.error('Error updating best link:', error);
        }
    }

    /**
     * Endpoint manual: GET /api/process
     */
    public async process(_req: Request, res: Response): Promise<void> {
        try {
            const data = await this.executeProcessInternal();
            res.status(200).json({
                success: true,
                message: 'Process executado - melhor eCPM geral encontrado',
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
     * Redirect principal com distribuição 60/40
     * 60% -> melhor link (eCPM)
     * 40% -> /random rotacionando domínios sequencialmente
     */
    public async redirect(req: Request, res: Response): Promise<void> {
        try {
            if (req.path.includes('favicon') || req.url.includes('favicon')) {
                res.status(204).end();
                return;
            }

            const ignoredParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                                  'fbclid', 'gclid', 'msclkid', 'ref', 'referrer', '_ga', '_gid'];

            const cleanQuery: Record<string, any> = {};
            for (const [key, value] of Object.entries(req.query)) {
                if (!ignoredParams.includes(key) && !key.startsWith('utm_')) {
                    cleanQuery[key] = value;
                }
            }

            const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
                           req.socket.remoteAddress || 'unknown';
            const requestKey = `${clientIp}_${req.path}_${JSON.stringify(cleanQuery)}`;

            // Anti-duplicação
            if (this.redisClient) {
                const wasRecent = await this.redisClient.get(`recent:${requestKey}`);
                if (wasRecent) {
                    res.redirect(wasRecent);
                    return;
                }
            }

            const counter = await this.getAndIncrementCounter();
            const cyclePosition = ((counter - 1) % 10) + 1;
            const usePrimaryLink = cyclePosition <= this.TRAFFIC_DISTRIBUTION.PRIMARY;

            let redirectUrl: string | null = null;
            let linkId: string | null = null;

            // Verificar idioma
            const language = req.query.language as string;

            if (usePrimaryLink) {
                // 60%: Usar o melhor link (cache ou banco)
                const bestLink = await this.getBestLink();
                if (bestLink) {
                    redirectUrl = bestLink.url;
                    linkId = bestLink.id;
                } else {
                    // Fallback se não tiver link
                    redirectUrl = `https://${domains[0]}${generateRandomPath()}`;
                    linkId = `fallback_no_best`;
                }
            } else {
                // 40%: Rotacionar domínios sequencialmente
                const fallbackIndex = await this.getNextFallbackIndex();
                const domain = domains[fallbackIndex];
                redirectUrl = `https://${domain}${generateRandomPath()}`;
                linkId = `random_${domain}`;
            }

            if (!redirectUrl) {
                redirectUrl = 'https://useuapp.com/random';
                linkId = 'fallback_emergency';
            }

            // Domínios com lógica invertida de idioma
            const invertedLangDomains = ['appmobile4u.com', 'appcombos.com'];
            const url = new URL(redirectUrl);
            const isInvertedDomain = invertedLangDomains.some(d => url.hostname.includes(d));

            // Adicionar prefixo de idioma
            if (isInvertedDomain) {
                // Para appmobile4u e appcombos: sem language = /en/, com pt = direto
                if (!language || language === 'en') {
                    url.pathname = `/en${url.pathname}`;
                    redirectUrl = url.toString();
                } else if (language !== 'pt') {
                    // Outros idiomas (es, fr, it, etc) adiciona o prefixo
                    url.pathname = `/${language}${url.pathname}`;
                    redirectUrl = url.toString();
                }
                // Se language=pt, não adiciona nada (acesso direto)
            } else {
                // Domínios normais: só adiciona prefixo se tiver language
                if (language) {
                    url.pathname = `/${language}${url.pathname}`;
                    redirectUrl = url.toString();
                }
            }

            // Log com informação de idioma
            const langInfo = language ? ` [${language.toUpperCase()}]` : (isInvertedDomain ? ' [EN]' : '');
            console.log(`[${usePrimaryLink ? '60%' : '40%'} LINK]${langInfo} ${redirectUrl}`);

            // UTM params
            const utmParams = new URLSearchParams();
            utmParams.append('utm_source', (req.query.utm_source as string) || 'jchat');
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

            // Cache anti-duplicação
            if (this.redisClient) {
                await this.redisClient.set(`recent:${requestKey}`, finalRedirectUrl, 'EX', 5);
            }

            res.redirect(finalRedirectUrl);
        } catch (error) {
            console.error('Error in redirect:', error);
            res.redirect('https://useuapp.com/random');
        }
    }

    /**
     * Obtém o melhor link do cache ou banco
     */
    private async getBestLink(): Promise<{ url: string; id: string } | null> {
        try {
            // Tentar cache primeiro
            if (this.redisClient) {
                const cached = await this.redisClient.get(this.BEST_LINK_CACHE_KEY);
                if (cached) {
                    const data = JSON.parse(cached);
                    return { url: data.url, id: 'best_ecpm' };
                }
            }

            // Fallback: buscar do banco
            if (this.redirectLinkRepository) {
                const allLinks = await this.redirectLinkRepository.getAllLinks(100, 0);
                const activeLink = allLinks.find(link => link.status === true);
                if (activeLink) {
                    return { url: activeLink.url, id: activeLink._id?.toString() || 'db_link' };
                }
            }

            return null;
        } catch (error) {
            console.error('Error getting best link:', error);
            return null;
        }
    }

    /**
     * Obtém próximo índice de fallback (rotaciona 0,1,2,3,0,1,2,3...)
     */
    private async getNextFallbackIndex(): Promise<number> {
        try {
            const counter = await redis.incr(this.FALLBACK_COUNTER_KEY);
            return (counter - 1) % domains.length;
        } catch (error) {
            return Math.floor(Math.random() * domains.length);
        }
    }

    private async getAndIncrementCounter(): Promise<number> {
        try {
            const counter = await redis.incr(this.COUNTER_KEY);
            if (counter > 1000000) {
                await redis.set(this.COUNTER_KEY, '1');
                return 1;
            }
            return counter;
        } catch (error) {
            console.error('Error with Redis counter:', error);
            return Math.floor(Math.random() * 10) + 1;
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
            const currentCounter = await redis.get(this.COUNTER_KEY) || '0';

            res.status(200).json({
                gam: gamStats,
                clicks: clickStats,
                traffic: {
                    currentCounter: parseInt(currentCounter),
                    distribution: {
                        primary: `${this.TRAFFIC_DISTRIBUTION.PRIMARY * 10}%`,
                        fallback: `${this.TRAFFIC_DISTRIBUTION.FALLBACK * 10}%`
                    }
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
