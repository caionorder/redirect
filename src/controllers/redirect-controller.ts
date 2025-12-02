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
import { generateRandomPath, getDomainForCurrentHour, getDomainForNextHour } from '../config/domains';

export class RedirectController {
    private db?: Db;
    private superFilterService: SuperFilterService;
    private gamAdUnitRepository?: GamAdUnitRepository;
    private redirectLinkRepository?: RedirectLinkRepository;
    private redirectClickRepository?: RedirectClickRepository;
    private redisClient: typeof redis | null;

    // Constantes para controle de tráfego
    private readonly TRAFFIC_DISTRIBUTION = {
        PRIMARY: 6,  // 60% do tráfego vai para links do banco
        FALLBACK: 4  // 40% do tráfego vai para domínios de fallback
    };
    private readonly COUNTER_KEY = 'redirect:traffic:counter';

    constructor(db?: Db) {
        this.db = db;
        this.superFilterService = new SuperFilterService();
        this.redisClient = redis;

        if (db) {
            this.gamAdUnitRepository = new GamAdUnitRepository(db);
            this.redirectLinkRepository = new RedirectLinkRepository(db);
            this.redirectClickRepository = new RedirectClickRepository(db);
        }

        // IMPORTANTE: Inicializar o cron job APENAS em UM processo
        // Para evitar execução duplicada em modo cluster
        const isMainProcess = !cluster.isWorker || cluster.worker?.id === 1;

        if (isMainProcess) {
            this.initializeScheduledProcess();
        }
    }

    /**
     * Inicializa o agendamento do processo para executar no último minuto de cada hora
     * Isso garante que os dados estejam prontos para a próxima hora
     */
    private initializeScheduledProcess(): void {
        const task = cron.schedule('59 * * * *', async () => {
            try {
                await this.executeProcessInternal();
            } catch (error) {
                console.error('[CRON] Erro:', error);
            }
        });
        task.start();
    }

    /**
     * Executa o processo internamente (usado pelo cron e endpoint manual)
     * @param forNextHour - se true, processa para próxima hora (usado pelo cron); se false, processa hora atual
     */
    private async executeProcessInternal(forNextHour: boolean = true): Promise<any> {
        const date = new Date();
        const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const custom_key = "id_post_wp";
        const group = [
            "domain",
            "custom_key",
            "custom_value"
        ];

        // Obter o domínio baseado no parâmetro
        const targetDomain = forNextHour ? getDomainForNextHour() : getDomainForCurrentHour();

        // Converter query para IFilterRequest - filtra apenas pelo domínio da próxima hora
        const filterRequest: IFilterRequest = {
            start: today.toISOString().split('T')[0],
            end: today.toISOString().split('T')[0],
            domain: targetDomain, // Apenas o domínio da próxima hora
            custom_key: custom_key,
            group: group
        };

        // Verificar se o repository existe
        if (!this.gamAdUnitRepository) {
            throw new Error('Database not connected');
        }

        // Executar o filtro usando o GamAdUnitRepository
        let data = await this.superFilterService.execute(filterRequest, this.gamAdUnitRepository);

        // Verificar se é um array (não um erro)
        if (Array.isArray(data)) {
            // Ordenar por eCPM decrescente e pegar o melhor resultado
            if (data.length > 0) {
                const reorderedData = data.sort((a, b) => {
                    const ecpmA = parseFloat(String(a.ecpm || 0));
                    const ecpmB = parseFloat(String(b.ecpm || 0));
                    return ecpmB - ecpmA; // Ordem decrescente
                });
                data = [reorderedData[0]];
            }
        }

        // Se temos dados e redirect link repository, processar links para o domínio da próxima hora
        if (Array.isArray(data) && data.length > 0 && this.redirectLinkRepository) {
            await this.processRedirectLinksForHour(data, targetDomain);
        }

        return data;
    }

    /**
     * Processa requisições de filtro/analytics e cria/atualiza redirect links
     * Endpoint: GET /api/process
     */
    public async process(req: Request, res: Response): Promise<void> {
        try {
            // Processa para a hora ATUAL (não próxima hora)
            const data = await this.executeProcessInternal(false);
            const currentDomain = getDomainForCurrentHour();
            res.status(200).json({
                success: true,
                message: `Process executado para hora atual - Domínio: ${currentDomain}`,
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
     * Processa os dados para criar/atualizar redirect links para um domínio específico (por hora)
     * Mantém apenas o link com melhor eCPM ativo para o domínio
     */
    private async processRedirectLinksForHour(data: any[], targetDomain: string): Promise<void> {
        if (!this.redirectLinkRepository) return;

        try {
            // Desativar todos os links existentes do domínio alvo
            const existingLinks = await this.redirectLinkRepository.getLinksByDomain(targetDomain);

            for (const link of existingLinks) {
                if (link._id) {
                    await this.redirectLinkRepository.updateLink(link._id.toString(), { status: false });
                }
            }

            // Processar o item com melhor eCPM (já vem apenas 1 do executeProcessInternal)
            for (const item of data) {
                if (item.domain && item.custom_value) {
                    // Construir URL de redirecionamento: domain?p=custom_value
                    const redirectUrl = `https://${item.domain}/?p=${encodeURIComponent(item.custom_value)}`;

                    // Verificar se já existe um link para este domain/url
                    const existingLink = await this.redirectLinkRepository.getLinkByDomainAndUrl(item.domain, redirectUrl);

                    if (existingLink && existingLink._id) {
                        await this.redirectLinkRepository.updateLink(existingLink._id.toString(), {
                            status: true
                        });
                    } else {
                        await this.redirectLinkRepository.createLink({
                            domain: item.domain,
                            url: redirectUrl,
                            status: true
                        });
                    }
                }
            }

            // Invalidar cache do domínio para forçar nova busca
            if (this.redisClient) {
                await this.redisClient.del(`active_link:${targetDomain}`);
            }
        } catch (error) {
            console.error('Error processing redirect links for hour:', error);
        }
    }

    /**
     * Processa redirecionamentos com distribuição de tráfego 60/40
     * Endpoint: GET /api/redirect
     */
    public async redirect(req: Request, res: Response): Promise<void> {
        try {
            // Ignorar requisições de favicon e outras não relacionadas
            if (req.path.includes('favicon') || req.url.includes('favicon')) {
                res.status(204).end();
                return;
            }

            // Listar parâmetros ignorados (tracking, analytics, etc)
            const ignoredParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                                  'fbclid', 'gclid', 'msclkid', 'ref', 'referrer', '_ga', '_gid'];

            // Filtrar query params, removendo os ignorados
            const cleanQuery: Record<string, any> = {};
            for (const [key, value] of Object.entries(req.query)) {
                if (!ignoredParams.includes(key) && !key.startsWith('utm_')) {
                    cleanQuery[key] = value;
                }
            }

            // Criar uma chave única para a requisição (baseada em IP + path + query limpa)
            const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
                           req.socket.remoteAddress ||
                           'unknown';
            const requestKey = `${clientIp}_${req.path}_${JSON.stringify(cleanQuery)}`;

            // Verificar se essa requisição já foi processada recentemente (anti-duplicação)
            if (this.redisClient) {
                const recentKey = `recent:${requestKey}`;
                const wasRecent = await this.redisClient.get(recentKey);

                if (wasRecent) {
                    res.redirect(wasRecent);
                    return;
                }
            }

            // Incrementar e obter contador
            const counter = await this.getAndIncrementCounter();

            // Calcular posição no ciclo (1-10)
            const cyclePosition = ((counter - 1) % 10) + 1;

            // Obter o domínio da hora atual
            const currentHourDomain = getDomainForCurrentHour();

            // Determinar se deve usar link do banco (60%) ou random (40%)
            const usePrimaryLink = cyclePosition <= this.TRAFFIC_DISTRIBUTION.PRIMARY;

            let redirectUrl: string | null = null;
            let linkId: string | null = null;

            if (usePrimaryLink) {
                // Posições 1-6 (60%): Usar link com melhor eCPM do domínio da hora atual
                if (this.redirectLinkRepository) {
                    const activeLink = await this.getActiveRedirectLinkForDomain(currentHourDomain);

                    if (activeLink) {
                        redirectUrl = activeLink.url;
                        linkId = activeLink.id;
                        console.log(`[60% LINK] ${redirectUrl}`);
                    } else {
                        redirectUrl = `https://${currentHourDomain}${generateRandomPath()}`;
                        linkId = `fallback_no_active_${currentHourDomain}`;
                        console.log(`[60% LINK] ${redirectUrl}`);
                    }
                }
            } else {
                // Posições 7-10 (40%): Usar domínio da hora atual + /random
                redirectUrl = `https://${currentHourDomain}${generateRandomPath()}`;
                linkId = `random_${currentHourDomain}`;
                console.log(`[40% LINK] ${redirectUrl}`);
            }

            // Garantir que sempre temos uma URL válida
            if (!redirectUrl) {
                redirectUrl = 'https://useuapp.com/random';
                linkId = 'fallback_emergency';
            }

            // Preparar parâmetros UTM para adicionar à URL
            const utmParams = new URLSearchParams();

            // utm_source: usar o da request ou 'jchat' como padrão
            const utmSource = (req.query.utm_source as string) || 'jchat';
            utmParams.append('utm_source', utmSource);

            // utm_medium: usar o da request ou 'broadcast' como padrão
            const utmMedium = (req.query.utm_medium as string) || 'broadcast';
            utmParams.append('utm_medium', utmMedium);

            // utm_campaign: usar o da request ou o link_id como padrão
            const utmCampaign = (req.query.utm_campaign as string) || linkId || 'direct';
            utmParams.append('utm_campaign', utmCampaign);

            // Adicionar os parâmetros UTM à URL final
            const separator = redirectUrl.includes('?') ? '&' : '?';
            const finalRedirectUrl = `${redirectUrl}${separator}${utmParams.toString()}`;

            // Registrar o click
            if (linkId && this.redirectClickRepository) {
                this.redirectClickRepository.incrementClick(linkId)
                    .then(result => console.log(`[CLICK RECORDED] LinkID: ${linkId}, New Count: ${result.count}`))
                    .catch(() => {});
            }

            // Salvar no cache para evitar duplicação (TTL de 5 segundos)
            if (this.redisClient) {
                await this.redisClient.set(`recent:${requestKey}`, finalRedirectUrl, 'EX', 5);
            }

            res.redirect(finalRedirectUrl);
        } catch (error) {
            console.error('Error in redirect:', error);
            // Em caso de erro, redirecionar para fallback
            res.redirect('https://useuapp.com/random');
        }
    }

    /**
     * Obtém e incrementa o contador de tráfego
     */
    private async getAndIncrementCounter(): Promise<number> {
        try {
            const counter = await redis.incr(this.COUNTER_KEY);

            // Reset contador se muito alto (evitar overflow)
            if (counter > 1000000) {
                await redis.set(this.COUNTER_KEY, '1');
                return 1;
            }

            return counter;
        } catch (error) {
            console.error('Error with Redis counter:', error);
            // Fallback: usar random se Redis falhar
            return Math.floor(Math.random() * 10) + 1;
        }
    }

    /**
     * Obtém o link ativo para um domínio específico (usado na lógica de hora)
     * Usa cache Redis para evitar queries repetidas ao MongoDB
     */
    private async getActiveRedirectLinkForDomain(domain: string): Promise<{ url: string; id: string } | null> {
        const cacheKey = `active_link:${domain}`;

        try {
            // Tentar buscar do cache primeiro
            if (this.redisClient) {
                const cached = await this.redisClient.get(cacheKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            }

            // Se não tem cache, buscar do banco
            if (!this.redirectLinkRepository) return null;

            const domainLinks = await this.redirectLinkRepository.getLinksByDomain(domain);
            const activeLinks = domainLinks.filter(link => link.status === true);

            if (activeLinks.length === 0) return null;

            const selectedLink = activeLinks[0];
            const result = {
                url: selectedLink.url,
                id: selectedLink._id?.toString() || ''
            };

            // Salvar no cache por 1 hora (3600 segundos)
            if (this.redisClient) {
                await this.redisClient.set(cacheKey, JSON.stringify(result), 'EX', 3600);
            }

            return result;
        } catch (error) {
            console.error(`Error getting active redirect link for domain ${domain}:`, error);
            return null;
        }
    }

    /**
     * Retorna estatísticas dos dados GAM
     * Endpoint: GET /api/stats
     */
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

            // Obter estatísticas do GAM
            const gamStats = await this.gamAdUnitRepository.getStats(query);

            // Obter estatísticas de clicks
            const clickStats = await this.redirectClickRepository.getStats();

            // Obter contador atual de tráfego
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

    /**
     * Retorna valores distintos de um campo
     * Endpoint: GET /api/distinct/:field
     */
    public async getDistinctValues(req: Request, res: Response): Promise<void> {
        try {
            if (!this.gamAdUnitRepository) {
                res.status(503).json({ error: 'Database not connected' });
                return;
            }

            const field = req.params.field as any;
            const validFields = ['domain', 'network', 'country', 'custom_key', 'custom_value', 'ad_unit_name'];

            if (!validFields.includes(field)) {
                res.status(400).json({
                    error: 'Invalid field',
                    validFields
                });
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

    /**
     * Retorna links de redirecionamento
     * Endpoint: GET /api/links
     */
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
