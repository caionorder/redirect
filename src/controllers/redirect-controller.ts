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
import { getActiveFallbackDomains, generateRandomPath } from '../config/domains';
import { domains } from '../config/domains';

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
        } else {
            console.log(`[CRON] Skipping cron initialization for worker ${cluster.worker?.id}`);
        }
    }

    /**
     * Inicializa o agendamento do processo para executar a cada hora
     */
    private initializeScheduledProcess(): void {
        // Agendar para executar no minuto 0 de cada hora (XX:00)
        const task = cron.schedule('0 * * * *', async () => {
            console.log('[CRON] Executando process agendado:', new Date().toISOString());
            try {
                await this.executeProcessInternal();
                console.log('[CRON] Process executado com sucesso');
            } catch (error) {
                console.error('[CRON] Erro ao executar process agendado:', error);
            }
        });

        // Iniciar o cron job
        task.start();
        console.log('[CRON] Agendamento do process inicializado - executará a cada hora');
    }

    /**
     * Executa o processo internamente (usado pelo cron e endpoint manual)
     */
    private async executeProcessInternal(): Promise<any> {
        const date = new Date();
        const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const yesterday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
        const custom_key = "id_post_wp";
        const group = [
            "domain",
            "custom_key",
            "custom_value"
        ]

        // Converter query para IFilterRequest
        const filterRequest: IFilterRequest = {
            start: yesterday.toISOString().split('T')[0],
            end: today.toISOString().split('T')[0],
            domain: domains,
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
            // Top 10 maiores revenues
            if (data.length > 5) {
                data.splice(10);
                const reorderedData = data.sort((a, b) => {
                    const ecpmA = parseFloat(String(a.ecpm || 0));
                    const ecpmB = parseFloat(String(b.ecpm || 0));
                    return ecpmB - ecpmA; // Ordem decrescente
                });
                data = reorderedData;
                data.splice(1);
            }
        }

        // Se temos dados e redirect link repository, processar links
        if (Array.isArray(data) && data.length > 0 && this.redirectLinkRepository) {
            await this.processRedirectLinks(data);
        }

        return data;
    }

    /**
     * Processa requisições de filtro/analytics e cria/atualiza redirect links
     * Endpoint: GET /api/process
     */
    public async process(req: Request, res: Response): Promise<void> {
        try {
            console.log('[MANUAL] Process executado manualmente via endpoint');
            const data = await this.executeProcessInternal();
            res.status(200).json({
                success: true,
                message: 'Process executado com sucesso',
                data: data,
                nextRun: 'Em 1 hora (agendamento automático)'
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
     * Processa os dados para criar/atualizar redirect links
     */
    private async processRedirectLinks(data: any[]): Promise<void> {
        if (!this.redirectLinkRepository) return;

        try {
            // Primeiro, desativar todos os links existentes dos domínios processados
            const domainsInData = [...new Set(data.map(item => item.domain).filter(Boolean))];

            for (const domain of domainsInData) {
                // Buscar todos os links do domínio
                const existingLinks = await this.redirectLinkRepository.getLinksByDomain(domain);

                // Desativar todos
                for (const link of existingLinks) {
                    if (link._id) {
                        await this.redirectLinkRepository.updateLink(link._id.toString(), { status: false });
                    }
                }
            }

            // Processar cada item de dados para criar/atualizar redirect links
            for (const item of data) {
                if (item.domain && item.custom_value) {
                    // Construir URL de redirecionamento: domain?p=custom_value
                    const redirectUrl = `https://${item.domain}/?p=${encodeURIComponent(item.custom_value)}`;

                    // Verificar se já existe um link para este domain/url
                    const existingLink = await this.redirectLinkRepository.getLinkByDomainAndUrl(item.domain, redirectUrl);

                    if (existingLink && existingLink._id) {
                        // Atualizar link existente para ativo
                        await this.redirectLinkRepository.updateLink(existingLink._id.toString(), {
                            status: true
                        });
                    } else {
                        // Criar novo link
                        await this.redirectLinkRepository.createLink({
                            domain: item.domain,
                            url: redirectUrl,
                            status: true
                        });
                    }
                }
            }
        } catch (error) {
            console.error('Error processing redirect links:', error);
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
                    console.log(`[DUPLICATE REQUEST] Ignoring duplicate from ${clientIp}`);
                    // Redirecionar para o mesmo lugar sem contar novamente
                    const lastUrl = wasRecent;
                    res.redirect(lastUrl);
                    return;
                }
            }

            // Log da requisição para debug
            console.log(`[REDIRECT REQUEST]`, {
                path: req.path,
                clientIp: clientIp,
                originalQuery: Object.keys(req.query).length > 0 ? req.query : 'none',
                cleanQuery: Object.keys(cleanQuery).length > 0 ? cleanQuery : 'none'
            });

            // Incrementar e obter contador
            const counter = await this.getAndIncrementCounter();

            // Calcular posição no ciclo (1-10)
            const cyclePosition = ((counter - 1) % 10) + 1;

            // Determinar se deve usar link do banco (60%) ou fallback (40%)
            const usePrimaryLink = cyclePosition <= this.TRAFFIC_DISTRIBUTION.PRIMARY;

            let redirectUrl: string | null = null;
            let linkId: string | null = null;

            if (usePrimaryLink) {
                // Posições 1-6: Tentar usar links do banco
                if (this.redirectLinkRepository) {
                    const activeLink = await this.getActiveRedirectLinkWithId();

                    if (activeLink) {
                        redirectUrl = activeLink.url;
                        linkId = activeLink.id;
                        console.log(`[USING DB LINK] Position ${cyclePosition}: ${redirectUrl}`);
                    } else {
                        // Não há links ativos no banco, usar fallback padrão
                        redirectUrl = `https://${domains[0]}${generateRandomPath()}`;
                        linkId = `fallback_no_active_links`;
                        console.log(`[NO ACTIVE LINKS] Position ${cyclePosition}: Using default fallback`);
                    }
                }
            } else {
                // Posições 7-10: Usar fallback domains sequencialmente
                const domainIndex = cyclePosition - 7; // 7->0, 8->1, 9->2, 10->3

                if (domainIndex >= 0 && domainIndex < domains.length) {
                    redirectUrl = `https://${domains[domainIndex]}${generateRandomPath()}`;
                    linkId = `fallback_${domains[domainIndex]}`;
                    console.log(`[USING FALLBACK] Position ${cyclePosition}: Domain ${domains[domainIndex]}`);
                } else {
                    // Fallback de segurança (não deveria acontecer)
                    redirectUrl = `https://${domains[0]}${generateRandomPath()}`;
                    linkId = `fallback_error`;
                    console.log(`[ERROR] Invalid domain index: ${domainIndex}`);
                }
            }

            // Garantir que sempre temos uma URL válida
            if (!redirectUrl) {
                redirectUrl = 'https://useuapp.com/random';
                linkId = 'fallback_emergency';
                console.error('[EMERGENCY] No redirect URL available!');
            }

            // Verificar se vamos realmente fazer o redirect antes de contar
            if (!redirectUrl) {
                console.error('[ERROR] No redirect URL available, aborting!');
                res.status(500).json({ error: 'No redirect URL available' });
                return;
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

            // Registrar o click SOMENTE se temos URL e ID válidos
            if (linkId && redirectUrl && this.redirectClickRepository) {
                try {
                    const clickResult = await this.redirectClickRepository.incrementClick(linkId);
                    console.log(`[CLICK RECORDED] LinkID: ${linkId}, New Count: ${clickResult.count}`);
                } catch (error) {
                    console.error('[ERROR] Failed to record click:', error);
                    // Continua com o redirect mesmo se falhar ao registrar o click
                }
            }

            // Salvar no cache para evitar duplicação (TTL de 5 segundos)
            if (this.redisClient && requestKey) {
                const recentKey = `recent:${requestKey}`;
                await this.redisClient.set(recentKey, finalRedirectUrl, 'EX', 5);
            }

            // Log final antes do redirect
            console.log(`[REDIRECT FINAL]`, {
                counter,
                cyclePosition,
                usePrimaryLink,
                linkId,
                originalUrl: redirectUrl,
                finalUrl: finalRedirectUrl,
                utmParams: {
                    source: utmSource,
                    medium: utmMedium,
                    campaign: utmCampaign
                }
            });

            // Executar o redirect com os parâmetros UTM
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
     * Obtém um link de redirecionamento ativo do banco
     */
    private async getActiveRedirectLink(): Promise<string | null> {
        if (!this.redirectLinkRepository) return null;

        try {
            // Buscar todos os links ativos
            const activeLinks = await this.redirectLinkRepository.getAllLinks(100, 0);
            const activeLinksList = activeLinks.filter(link => link.status === true);

            if (activeLinksList.length === 0) return null;

            // Escolher um link aleatório dos ativos
            const randomIndex = Math.floor(Math.random() * activeLinksList.length);
            return activeLinksList[randomIndex].url;
        } catch (error) {
            console.error('Error getting active redirect link:', error);
            return null;
        }
    }

    /**
     * Obtém um link de redirecionamento ativo do banco com ID
     */
    private async getActiveRedirectLinkWithId(): Promise<{ url: string; id: string } | null> {
        if (!this.redirectLinkRepository) return null;

        try {
            // Buscar todos os links ativos
            const activeLinks = await this.redirectLinkRepository.getAllLinks(100, 0);
            const activeLinksList = activeLinks.filter(link => link.status === true);

            if (activeLinksList.length === 0) return null;

            // Escolher um link aleatório dos ativos
            const randomIndex = Math.floor(Math.random() * activeLinksList.length);
            const selectedLink = activeLinksList[randomIndex];

            return {
                url: selectedLink.url,
                id: selectedLink._id?.toString() || ''
            };
        } catch (error) {
            console.error('Error getting active redirect link with ID:', error);
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
