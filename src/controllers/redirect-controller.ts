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
import { generateRandomPath, domains, domains_db } from '../config/domains';

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
    private redisClient: typeof redis | null;

    // Chaves Redis
    private readonly DOMAIN_COUNTER_KEY = 'redirect:domain:counter';
    private readonly BEST_LINKS_MAP_KEY = 'redirect:best_links_map';
    private readonly VISITOR_PREFIX = 'visitor';

    // Chaves Redis para domains_db
    private readonly DOMAIN_DB_COUNTER_KEY = 'redirect:domain_db:counter';
    private readonly BEST_LINKS_MAP_DB_KEY = 'redirect:best_links_map_db';

    // Chave Redis para regras de redirecionamento
    private readonly REDIRECT_RULES_KEY = 'redirect:rules';

    // Chave Redis para regras de in-app
    private readonly INAPP_RULES_KEY = 'redirect:inapp_rules';

    // Cache em memória para evitar chamadas repetidas ao Redis
    private bestLinksMapCache: BestLinkMap | null = null;
    private bestLinksMapCacheTime: number = 0;
    private readonly CACHE_TTL_MS = 60000; // 1 minuto de cache em memória

    // Cache em memória para domains_db
    private bestLinksMapDbCache: BestLinkMap | null = null;
    private bestLinksMapDbCacheTime: number = 0;

    // Cache em memória para regras de redirecionamento
    private rulesCache: RedirectRule[] | null = null;
    private rulesCacheTime: number = 0;

    // Cache em memória para regras de in-app
    private inAppRulesCache: InAppRule[] | null = null;
    private inAppRulesCacheTime: number = 0;

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

        // Executar imediatamente para domains_db
        this.executeProcessInternalDb()
            .then(() => console.log('[CRON] Cache inicial DB populado com sucesso'))
            .catch(err => console.error('[CRON] Erro ao popular cache inicial DB:', err));

        // Agendar para rodar no minuto 30
        const task = cron.schedule('30 * * * *', async () => {
            console.log('[CRON] Executando atualização agendada...');
            try {
                await this.executeProcessInternal();
                await this.executeProcessInternalDb();
            } catch (error) {
                console.error('[CRON] Erro:', error);
            }
        });
        task.start();
    }

    /**
     * Busca em TODOS os dominios o melhor post (maior eCPM) de CADA dominio
     * Salva no Redis um mapa: { dominio: melhor_url }
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
            console.log(`[CRON] Mapa de melhores links atualizado: ${Object.keys(bestByDomain).length} dominios`);
        }

        // Log dos melhores links
        for (const [domain, info] of Object.entries(bestByDomain)) {
            console.log(`[CRON] ${domain} -> p=${info.postId} (eCPM: ${info.ecpm.toFixed(4)})`);
        }

        return bestByDomain;
    }

    /**
     * Busca em domains_db o melhor post (maior eCPM) de CADA dominio
     * Salva no Redis um mapa separado: { dominio: melhor_url }
     */
    private async executeProcessInternalDb(): Promise<BestLinkMap | null> {
        if (domains_db.length === 0) {
            console.log('[CRON-DB] Nenhum domínio configurado em domains_db');
            return null;
        }

        const date = new Date();
        const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());

        const filterRequest: IFilterRequest = {
            start: today.toISOString().split('T')[0],
            end: today.toISOString().split('T')[0],
            domain: domains_db,
            custom_key: "id_post_wp",
            group: ["domain", "custom_key", "custom_value"]
        };

        if (!this.gamAdUnitRepository) {
            throw new Error('Database not connected');
        }

        const data = await this.superFilterService.execute(filterRequest, this.gamAdUnitRepository);

        if (!Array.isArray(data) || data.length === 0) {
            console.log('[CRON-DB] Nenhum dado encontrado para processar');
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
                this.BEST_LINKS_MAP_DB_KEY,
                JSON.stringify(bestByDomain),
                'EX',
                3600
            );
            console.log(`[CRON-DB] Mapa de melhores links DB atualizado: ${Object.keys(bestByDomain).length} dominios`);
        }

        // Log dos melhores links
        for (const [domain, info] of Object.entries(bestByDomain)) {
            console.log(`[CRON-DB] ${domain} -> p=${info.postId} (eCPM: ${info.ecpm.toFixed(4)})`);
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
     * Gera a chave de visitante para rastreamento
     * Formato: visitor:{ip}:{hora}:{dominio}
     */
    private getVisitorKey(ip: string, domain: string): string {
        const hour = new Date().getHours();
        return `${this.VISITOR_PREFIX}:${ip}:${hour}:${domain}`;
    }

    /**
     * Verifica se o visitante ja viu o dominio nesta hora
     */
    private async hasVisitorSeenDomain(ip: string, domain: string): Promise<boolean> {
        if (!this.redisClient) return false;

        const key = this.getVisitorKey(ip, domain);
        const seen = await this.redisClient.get(key);
        return seen !== null;
    }

    /**
     * Obtem o proximo dominio na rotacao sequencial
     */
    private async getNextDomain(): Promise<string> {
        try {
            const counter = await redis.incr(this.DOMAIN_COUNTER_KEY);
            const index = (counter - 1) % domains.length;
            return domains[index];
        } catch (error) {
            // Fallback aleatorio em caso de erro
            return domains[Math.floor(Math.random() * domains.length)];
        }
    }

    /**
     * Obtem o proximo dominio na rotacao sequencial para domains_db
     */
    private async getNextDomainDb(): Promise<string> {
        try {
            const counter = await redis.incr(this.DOMAIN_DB_COUNTER_KEY);
            const index = (counter - 1) % domains_db.length;
            return domains_db[index];
        } catch (error) {
            // Fallback aleatorio em caso de erro
            return domains_db[Math.floor(Math.random() * domains_db.length)];
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
     * Obtem o mapa de melhores links do cache para domains_db (com cache em memória)
     */
    private async getBestLinksMapDb(): Promise<BestLinkMap | null> {
        try {
            // Verificar cache em memória primeiro
            const now = Date.now();
            if (this.bestLinksMapDbCache && (now - this.bestLinksMapDbCacheTime) < this.CACHE_TTL_MS) {
                return this.bestLinksMapDbCache;
            }

            if (!this.redisClient) return this.bestLinksMapDbCache;

            const cached = await this.redisClient.get(this.BEST_LINKS_MAP_DB_KEY);
            if (cached) {
                this.bestLinksMapDbCache = JSON.parse(cached) as BestLinkMap;
                this.bestLinksMapDbCacheTime = now;
                return this.bestLinksMapDbCache;
            }
            return this.bestLinksMapDbCache;
        } catch (error) {
            console.error('Error getting best links map DB:', error);
            return this.bestLinksMapDbCache;
        }
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
        await this.redisClient.set(this.REDIRECT_RULES_KEY, JSON.stringify(rules));
        this.rulesCache = rules;
        this.rulesCacheTime = Date.now();
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
        await this.redisClient.set(this.INAPP_RULES_KEY, JSON.stringify(rules));
        this.inAppRulesCache = rules;
        this.inAppRulesCacheTime = Date.now();
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
                    for (const [key, value] of Object.entries(req.query)) {
                        if (value) ruleUrl.searchParams.append(key, String(value));
                    }
                }
                console.log(`[RULE REDIRECT] ${matchedRule.id} (${matchedRule.description}) -> ${ruleUrl.toString()}`);
                res.redirect(ruleUrl.toString());
                return;
            }

            // Verificar regras de in-app: se NAO esta no in-app e tem utm_campaign cadastrada, redireciona
            const utmCampaign = req.query.utm_campaign as string;
            if (utmCampaign) {
                const userAgent = req.headers['user-agent'] || '';
                if (!this.isInAppBrowser(userAgent)) {
                    const inAppRules = await this.getInAppRules();
                    const inAppMatch = inAppRules.find(r => r.active && r.utm_campaign === utmCampaign);

                    if (inAppMatch) {
                        const inAppUrl = new URL(inAppMatch.destination);
                        if (inAppMatch.passQueryParams) {
                            for (const [key, value] of Object.entries(req.query)) {
                                if (value) inAppUrl.searchParams.append(key, String(value));
                            }
                        }
                        console.log(`[NOT-INAPP REDIRECT] ${inAppMatch.id} campaign=${utmCampaign} -> ${inAppUrl.toString()}`);
                        res.redirect(inAppUrl.toString());
                        return;
                    }
                }
            }

            // Identificar visitante por IP
            const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                           req.socket.remoteAddress || 'unknown';

            // Obter o proximo dominio na rotacao
            const domain = await this.getNextDomain();
            const visitorKey = this.getVisitorKey(clientIp, domain);

            // Verificar idioma
            const language = req.query.language as string;

            // Verificar se o visitante ja viu este dominio nesta hora
            const hasSeenDomain = await this.hasVisitorSeenDomain(clientIp, domain);

            let redirectUrl: string;
            let linkId: string;
            let logType: string;

            if (hasSeenDomain) {
                // Visitante ja viu este dominio nesta hora -> /random
                redirectUrl = `https://${domain}${generateRandomPath()}`;
                linkId = `random_${domain}`;
                logType = 'RANDOM LINK';
            } else {
                // Primeira visita do visitante neste dominio nesta hora -> melhor link
                const bestLinksMap = await this.getBestLinksMap();
                const bestLinkInfo = bestLinksMap?.[domain];

                if (bestLinkInfo) {
                    redirectUrl = bestLinkInfo.url;
                    linkId = `best_${domain}_${bestLinkInfo.postId}`;
                    logType = 'BEST LINK';
                } else {
                    // Fallback se nao tiver melhor link para este dominio
                    redirectUrl = `https://${domain}${generateRandomPath()}`;
                    linkId = `fallback_${domain}`;
                    logType = 'RANDOM LINK';
                    // Debug: mostrar porque caiu no fallback
                    if (!bestLinksMap) {
                        console.log(`[DEBUG] bestLinksMap está VAZIO - rode /api/process para popular`);
                    } else {
                        console.log(`[DEBUG] Domínio "${domain}" não encontrado no mapa. Domínios disponíveis: ${Object.keys(bestLinksMap).join(', ')}`);
                    }
                }

                // Marcar que o visitante viu este dominio (fire and forget)
                if (this.redisClient) {
                    this.redisClient.set(visitorKey, '1', 'EX', 3600).catch(() => {});
                }
            }

            // Dominios que NAO usam prefixo de idioma (vao "brutos")
            const noLangPrefixDomains = ['promo.dopeaaps.com',"promo.appmobile4u.com"];

            // Dominios com logica invertida de idioma
            const invertedLangDomains = ['appmobile4u.com', 'appcombos.com', 'informanoticia.com', 'buscaapp.com.br', 'lavoriinitalia.com'
                // 'cincosete.com'
            ];
            const url = new URL(redirectUrl);
            const isNoLangDomain = noLangPrefixDomains.some(d => url.hostname.includes(d));
            const isInvertedDomain = invertedLangDomains.some(d => url.hostname.includes(d));

            // Adicionar prefixo de idioma (exceto para dominios "brutos")
            if (!isNoLangDomain) {
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
            }

            // Log com informacao de idioma e dominio
            const langInfo = isNoLangDomain ? ' [BRUTO]' : (language ? ` [${language.toUpperCase()}]` : (isInvertedDomain ? ' [EN]' : ''));
            const visitInfo = hasSeenDomain ? ' (revisita)' : ' (1a visita)';
            console.log(`[${logType}]${langInfo} ${domain}${visitInfo} -> ${redirectUrl}`);

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

    /**
     * Redirect para domains_db com mesma logica:
     * - Rotaciona dominios_db sequencialmente
     * - Se visitante ja viu o dominio naquela hora -> /random
     * - Se primeira visita -> melhor link do dominio
     */
    public async redirectDb(req: Request, res: Response): Promise<void> {
        try {
            if (req.path.includes('favicon') || req.url.includes('favicon')) {
                res.status(204).end();
                return;
            }

            if (domains_db.length === 0) {
                res.status(503).json({ error: 'No domains_db configured' });
                return;
            }

            // Verificar regras de in-app: se NAO esta no in-app e tem utm_campaign cadastrada, redireciona
            const utmCampaignDb = req.query.utm_campaign as string;
            if (utmCampaignDb) {
                const userAgent = req.headers['user-agent'] || '';
                if (!this.isInAppBrowser(userAgent)) {
                    const inAppRules = await this.getInAppRules();
                    const inAppMatch = inAppRules.find(r => r.active && r.utm_campaign === utmCampaignDb);

                    if (inAppMatch) {
                        const inAppUrl = new URL(inAppMatch.destination);
                        if (inAppMatch.passQueryParams) {
                            for (const [key, value] of Object.entries(req.query)) {
                                if (value) inAppUrl.searchParams.append(key, String(value));
                            }
                        }
                        console.log(`[NOT-INAPP REDIRECT DB] ${inAppMatch.id} campaign=${utmCampaignDb} -> ${inAppUrl.toString()}`);
                        res.redirect(inAppUrl.toString());
                        return;
                    }
                }
            }

            // Identificar visitante por IP
            const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                           req.socket.remoteAddress || 'unknown';

            // Obter o proximo dominio na rotacao (domains_db)
            const domain = await this.getNextDomainDb();
            const visitorKey = this.getVisitorKey(clientIp, domain);

            // Verificar se o visitante ja viu este dominio nesta hora
            const hasSeenDomain = await this.hasVisitorSeenDomain(clientIp, domain);

            let redirectUrl: string;
            let linkId: string;
            let logType: string;

            if (hasSeenDomain) {
                // Visitante ja viu este dominio nesta hora -> /random
                redirectUrl = `https://${domain}${generateRandomPath()}`;
                linkId = `random_db_${domain}`;
                logType = 'RANDOM LINK DB';
            } else {
                // Primeira visita do visitante neste dominio nesta hora -> melhor link
                const bestLinksMap = await this.getBestLinksMapDb();
                const bestLinkInfo = bestLinksMap?.[domain];

                if (bestLinkInfo) {
                    redirectUrl = bestLinkInfo.url;
                    linkId = `best_db_${domain}_${bestLinkInfo.postId}`;
                    logType = 'BEST LINK DB';
                } else {
                    // Fallback se nao tiver melhor link para este dominio
                    redirectUrl = `https://${domain}${generateRandomPath()}`;
                    linkId = `fallback_db_${domain}`;
                    logType = 'RANDOM LINK DB';
                    // Debug: mostrar porque caiu no fallback
                    if (!bestLinksMap) {
                        console.log(`[DEBUG-DB] bestLinksMapDb está VAZIO - rode /api/process para popular`);
                    } else {
                        console.log(`[DEBUG-DB] Domínio "${domain}" não encontrado no mapa DB. Domínios disponíveis: ${Object.keys(bestLinksMap).join(', ')}`);
                    }
                }

                // Marcar que o visitante viu este dominio (fire and forget)
                if (this.redisClient) {
                    this.redisClient.set(visitorKey, '1', 'EX', 3600).catch(() => {});
                }
            }

            // domains_db não usa prefixo de idioma (/en/, /es/, etc)

            // Log
            const visitInfo = hasSeenDomain ? ' (revisita)' : ' (1a visita)';
            console.log(`[${logType}] ${domain}${visitInfo} -> ${redirectUrl}`);

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
                    .then(result => console.log(`[CLICK RECORDED DB] LinkID: ${linkId}, New Count: ${result.count}`))
                    .catch(() => {});
            }

            // Cache anti-duplicacao (fire and forget)
            if (this.redisClient) {
                this.redisClient.set(`recent:${clientIp}`, finalRedirectUrl, 'EX', 5).catch(() => {});
            }

            res.redirect(finalRedirectUrl);
        } catch (error) {
            console.error('Error in redirectDb:', error);
            // Fallback para primeiro dominio do domains_db
            const fallbackDomain = domains_db[0] || 'appmynews.com';
            res.redirect(`https://${fallbackDomain}/random`);
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
