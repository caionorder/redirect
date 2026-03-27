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
 * Interface para um link com eCPM
 */
interface LinkInfo {
    url: string;
    domain: string;
    postId: string;
    ecpm: number;
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
    private readonly BEST_LINKS_MAP_KEY = 'redirect:best_links_map';
    private readonly VISITOR_PREFIX = 'visitor';

    // Chaves Redis para domains_db
    private readonly BEST_LINKS_MAP_DB_KEY = 'redirect:best_links_map_db';

    // Chave Redis para regras de redirecionamento
    private readonly REDIRECT_RULES_KEY = 'redirect:rules';

    // Chave Redis para regras de in-app
    private readonly INAPP_RULES_KEY = 'redirect:inapp_rules';

    // Cache em memória para evitar chamadas repetidas ao Redis
    private bestLinksMapCache: RankedLinksList | null = null;
    private bestLinksMapCacheTime: number = 0;
    private readonly CACHE_TTL_MS = 60000; // 1 minuto de cache em memória

    // Cache em memória para domains_db
    private bestLinksMapDbCache: RankedLinksList | null = null;
    private bestLinksMapDbCacheTime: number = 0;

    // Cache em memória para regras de redirecionamento
    private rulesCache: RedirectRule[] | null = null;
    private rulesCacheTime: number = 0;

    // Cache em memória para regras de in-app
    private inAppRulesCache: InAppRule[] | null = null;
    private inAppRulesCacheTime: number = 0;

    // Cache em memória para posts válidos por domínio { domain: FetchPostIdsResult }
    private validPostsCache: Map<string, FetchPostIdsResult> = new Map();
    private validPostsCacheTime: number = 0;
    private readonly VALID_POSTS_CACHE_TTL_MS = 900000; // 15 minutos

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
     * Cron: a cada 15 minutos - busca ranking de eCPM de CADA dominio
     */
    private initializeScheduledProcess(): void {
        console.log('[CRON] Inicializando agendamento - executará a cada 15 minutos');

        // Executar imediatamente na inicialização para popular o cache
        this.executeProcessInternal()
            .then(() => console.log('[CRON] Cache inicial populado com sucesso'))
            .catch(err => console.error('[CRON] Erro ao popular cache inicial:', err));

        // Executar imediatamente para domains_db
        this.executeProcessInternalDb()
            .then(() => console.log('[CRON] Cache inicial DB populado com sucesso'))
            .catch(err => console.error('[CRON] Erro ao popular cache inicial DB:', err));

        // Agendar para rodar a cada 15 minutos
        const task = cron.schedule('*/15 * * * *', async () => {
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
     * Busca em TODOS os dominios os posts e cria ranking global por eCPM (do maior para o menor)
     * Salva no Redis uma lista: [{ url, domain, postId, ecpm }, ...]
     */
    private async executeProcessInternal(): Promise<RankedLinksList | null> {
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

        // Criar lista global de todos os links
        const globalRanking: RankedLinksList = [];

        let skipped = 0;
        for (const item of data) {
            if (!item.domain || !item.custom_value) continue;

            const impressions = Number(item.impressions || 0);
            if (impressions < 100) {
                skipped++;
                continue;
            }

            const domain = item.domain as string;
            const ecpm = parseFloat(String(item.ecpm || 0));
            const postId = String(item.custom_value);

            globalRanking.push({
                url: `https://${domain}/?p=${encodeURIComponent(postId)}`,
                domain: domain,
                postId: postId,
                ecpm: ecpm
            });
        }

        // Ordenar por eCPM decrescente (ranking global)
        globalRanking.sort((a, b) => b.ecpm - a.ecpm);

        // Validar posts via API WordPress (remover posts inexistentes)
        const validatedRanking = await this.validateRanking(globalRanking);

        // Salvar no cache Redis (1 hora)
        if (this.redisClient && validatedRanking.length > 0) {
            await this.redisClient.set(
                this.BEST_LINKS_MAP_KEY,
                JSON.stringify(validatedRanking),
                'EX',
                3600
            );
            console.log(`[CRON] Ranking global atualizado: ${validatedRanking.length} links (${skipped} ignorados por <1000 impressões)`);
        }

        // Log do top 5
        const top = validatedRanking.slice(0, 5);
        for (let i = 0; i < top.length; i++) {
            console.log(`[CRON] #${i + 1} ${top[i].domain} p=${top[i].postId} (eCPM: ${top[i].ecpm.toFixed(4)})`);
        }

        return validatedRanking;
    }

    /**
     * Busca em domains_db os posts e cria ranking global por eCPM (do maior para o menor)
     * Salva no Redis uma lista: [{ url, domain, postId, ecpm }, ...]
     * Apenas links com >= 1000 impressões são incluídos
     */
    private async executeProcessInternalDb(): Promise<RankedLinksList | null> {
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

        // Criar lista global de todos os links
        const globalRanking: RankedLinksList = [];

        let skipped = 0;
        for (const item of data) {
            if (!item.domain || !item.custom_value) continue;

            const impressions = Number(item.impressions || 0);
            if (impressions < 100) {
                skipped++;
                continue;
            }

            const domain = item.domain as string;
            const ecpm = parseFloat(String(item.ecpm || 0));
            const postId = String(item.custom_value);

            globalRanking.push({
                url: `https://${domain}/?p=${encodeURIComponent(postId)}`,
                domain: domain,
                postId: postId,
                ecpm: ecpm
            });
        }

        // Ordenar por eCPM decrescente (ranking global)
        globalRanking.sort((a, b) => b.ecpm - a.ecpm);

        // Validar posts via API WordPress (remover posts inexistentes)
        const validatedRanking = await this.validateRanking(globalRanking);

        // Salvar no cache Redis (1 hora)
        if (this.redisClient && validatedRanking.length > 0) {
            await this.redisClient.set(
                this.BEST_LINKS_MAP_DB_KEY,
                JSON.stringify(validatedRanking),
                'EX',
                3600
            );
            console.log(`[CRON-DB] Ranking global DB atualizado: ${validatedRanking.length} links (${skipped} ignorados por <1000 impressões)`);
        }

        // Log do top 5
        const top = validatedRanking.slice(0, 5);
        for (let i = 0; i < top.length; i++) {
            console.log(`[CRON-DB] #${i + 1} ${top[i].domain} p=${top[i].postId} (eCPM: ${top[i].ecpm.toFixed(4)})`);
        }

        return validatedRanking;
    }

    /**
     * Busca IDs paginados de um endpoint WP REST API (posts ou pages).
     * Retorna true se conseguiu buscar pelo menos uma página com sucesso.
     */
    private async fetchIdsFromEndpoint(domain: string, endpoint: string, validIds: Set<string>): Promise<boolean> {
        let page = 1;
        const perPage = 100;
        let atLeastOneSuccess = false;

        while (true) {
            const url = `https://${domain}/wp-json/wp/v2/${endpoint}?per_page=${perPage}&_fields=id&orderby=date&order=desc&page=${page}`;
            const response = await fetch(url, {
                signal: AbortSignal.timeout(10000),
                headers: { 'User-Agent': 'RedirectBot/1.0' }
            });

            if (!response.ok) {
                console.log(`[WP-VALIDATE] ${domain} ${endpoint} page=${page} HTTP ${response.status} - parando`);
                break;
            }

            atLeastOneSuccess = true;
            const items = await response.json() as Array<{ id: number }>;

            if (!Array.isArray(items) || items.length === 0) break;

            for (const item of items) {
                validIds.add(String(item.id));
            }

            if (items.length < perPage) break;
            page++;
        }

        return atLeastOneSuccess;
    }

    /**
     * Busca os IDs de posts e pages válidos de um domínio via API WordPress.
     * Retorna { success: true, ids } se pelo menos um endpoint respondeu,
     * ou { success: false, ids: empty } se ambos falharam.
     */
    private async fetchValidPostIds(domain: string): Promise<FetchPostIdsResult> {
        const validIds = new Set<string>();

        try {
            // Buscar posts e pages em paralelo
            const [postsOk, pagesOk] = await Promise.all([
                this.fetchIdsFromEndpoint(domain, 'posts', validIds).catch(() => false),
                this.fetchIdsFromEndpoint(domain, 'pages', validIds).catch(() => false),
            ]);

            if (!postsOk && !pagesOk) {
                console.error(`[WP-VALIDATE] ${domain}: ambos endpoints (posts + pages) falharam`);
                return { success: false, ids: validIds };
            }

            console.log(`[WP-VALIDATE] ${domain}: ${validIds.size} IDs válidos encontrados (posts: ${postsOk ? 'ok' : 'falhou'}, pages: ${pagesOk ? 'ok' : 'falhou'})`);
            return { success: true, ids: validIds };
        } catch (error) {
            console.error(`[WP-VALIDATE] Erro ao buscar posts/pages de ${domain}:`, error instanceof Error ? error.message : error);
            return { success: false, ids: validIds };
        }
    }

    /**
     * Busca posts válidos de todos os domínios presentes no ranking.
     * Retorna Map<domain, FetchPostIdsResult> para que o caller saiba se a API falhou ou não.
     * Se a API falhou para um domínio, tenta usar o cache anterior como fallback.
     */
    private async fetchAllValidPosts(domainsToCheck: string[]): Promise<Map<string, FetchPostIdsResult>> {
        const now = Date.now();

        // Usar cache se ainda válido
        if (this.validPostsCache.size > 0 && (now - this.validPostsCacheTime) < this.VALID_POSTS_CACHE_TTL_MS) {
            const allCached = domainsToCheck.every(d => this.validPostsCache.has(d));
            if (allCached) {
                console.log(`[WP-VALIDATE] Usando cache em memória (${this.validPostsCache.size} domínios)`);
                return this.validPostsCache;
            }
        }

        // Guardar referência ao cache anterior para fallback
        const previousCache = this.validPostsCache;

        const result = new Map<string, FetchPostIdsResult>();

        // Buscar todos os domínios em paralelo
        const promises = domainsToCheck.map(async (domain) => {
            const fetchResult = await this.fetchValidPostIds(domain);
            return { domain, fetchResult };
        });

        const results = await Promise.allSettled(promises);

        for (const r of results) {
            if (r.status === 'fulfilled') {
                const { domain, fetchResult } = r.value;

                if (!fetchResult.success) {
                    // API falhou — tentar usar cache anterior como fallback
                    const cached = previousCache.get(domain);
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

        // Atualizar cache apenas com resultados bem-sucedidos
        this.validPostsCache = result;
        this.validPostsCacheTime = now;

        return result;
    }

    /**
     * Filtra o ranking removendo posts que não existem no WordPress.
     * - Se a API respondeu com sucesso: filtra posts inexistentes.
     * - Se a API falhou E não tem cache anterior: remove todos os links do domínio.
     * - Se a API retornou 0 posts com sucesso: remove todos os links do domínio (domínio vazio).
     */
    private async validateRanking(ranking: RankedLinksList): Promise<RankedLinksList> {
        const uniqueDomains = [...new Set(ranking.map(link => link.domain))];

        if (uniqueDomains.length === 0) return ranking;

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

        return validated;
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
     * Gera a chave de visitante para rastreamento global
     * Formato: visitor:{type}:{ip}:{hora}
     * type: 'main' para domains, 'db' para domains_db
     */
    private getVisitorKey(ip: string, type: 'main' | 'db'): string {
        const hour = new Date().getHours();
        return `${this.VISITOR_PREFIX}:${type}:${ip}:${hour}`;
    }

    /**
     * Retorna quantas vezes o visitante ja acessou nesta hora (antes de incrementar)
     * e incrementa o contador. TTL 1 hora.
     */
    private async getVisitorVisitCount(ip: string, type: 'main' | 'db'): Promise<number> {
        if (!this.redisClient) return 0;

        const key = this.getVisitorKey(ip, type);
        const count = await this.redisClient.incr(key);
        // Setar TTL apenas na primeira visita (count === 1)
        if (count === 1) {
            await this.redisClient.expire(key, 3600);
        }
        // count=1 significa primeira visita (index 0), count=2 segunda (index 1), etc.
        return count - 1;
    }

    /**
     * Obtem o mapa de melhores links do cache (com cache em memória)
     */
    private async getBestLinksMap(): Promise<RankedLinksList | null> {
        try {
            // Verificar cache em memória primeiro
            const now = Date.now();
            if (this.bestLinksMapCache && (now - this.bestLinksMapCacheTime) < this.CACHE_TTL_MS) {
                return this.bestLinksMapCache;
            }

            if (!this.redisClient) return this.bestLinksMapCache;

            const cached = await this.redisClient.get(this.BEST_LINKS_MAP_KEY);
            if (cached) {
                this.bestLinksMapCache = JSON.parse(cached) as RankedLinksList;
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
    private async getBestLinksMapDb(): Promise<RankedLinksList | null> {
        try {
            // Verificar cache em memória primeiro
            const now = Date.now();
            if (this.bestLinksMapDbCache && (now - this.bestLinksMapDbCacheTime) < this.CACHE_TTL_MS) {
                return this.bestLinksMapDbCache;
            }

            if (!this.redisClient) return this.bestLinksMapDbCache;

            const cached = await this.redisClient.get(this.BEST_LINKS_MAP_DB_KEY);
            if (cached) {
                this.bestLinksMapDbCache = JSON.parse(cached) as RankedLinksList;
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

            // Verificar regras de in-app/iframe
            // utm_campaign pode vir da query string OU do path (/:campaignId)
            const utmCampaign = (req.query.utm_campaign as string) || (req.params.campaignId as string);
            console.log(`[DEBUG INAPP] campaignId=${req.params?.campaignId} utmCampaign=${utmCampaign} path=${req.path}`);
            if (utmCampaign) {
                const inAppRules = await this.getInAppRules();
                console.log(`[DEBUG INAPP] rules count=${inAppRules.length} rules=${JSON.stringify(inAppRules.map(r => ({ id: r.id, utm_campaign: r.utm_campaign, active: r.active })))}`);
                const inAppMatch = inAppRules.find(r => r.active && r.utm_campaign === utmCampaign);

                if (inAppMatch) {
                    const inAppUrl = new URL(inAppMatch.destination);
                    if (inAppMatch.passQueryParams) {
                        for (const [key, value] of Object.entries(req.query)) {
                            if (value) inAppUrl.searchParams.append(key, String(value));
                        }
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
                        console.log(`[INAPP REDIRECT] ${inAppMatch.id} campaign=${utmCampaign} -> ${finalUrl}`);
                        res.redirect(finalUrl);
                    } else {
                        // Não é in-app (Meta crawler, navegador normal) -> iframe
                        console.log(`[IFRAME] ${inAppMatch.id} campaign=${utmCampaign} -> ${finalUrl}`);
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

            // Contar visitas do visitante nesta hora (ranking global, sem dominio)
            const visitIndex = await this.getVisitorVisitCount(clientIp, 'main');

            // Buscar ranking global de links
            const globalRanking = await this.getBestLinksMap();

            let redirectUrl: string;
            let linkId: string;
            let logType: string;
            let domain: string;

            if (globalRanking && globalRanking.length > 0) {
                if (visitIndex < globalRanking.length) {
                    // Visita N -> pega o N-esimo melhor eCPM global
                    const linkInfo = globalRanking[visitIndex];
                    redirectUrl = linkInfo.url;
                    domain = linkInfo.domain;
                    linkId = `rank${visitIndex}_${domain}_${linkInfo.postId}`;
                    logType = `RANK #${visitIndex + 1}`;
                } else {
                    // Esgotou todos os links do ranking -> dominio aleatorio + /random
                    domain = domains[Math.floor(Math.random() * domains.length)];
                    redirectUrl = `https://${domain}${generateRandomPath()}`;
                    linkId = `random_${domain}`;
                    logType = 'RANDOM LINK';
                }
            } else {
                // Sem dados de ranking -> dominio aleatorio + /random
                domain = domains[Math.floor(Math.random() * domains.length)];
                redirectUrl = `https://${domain}${generateRandomPath()}`;
                linkId = `fallback_${domain}`;
                logType = 'RANDOM LINK';
                console.log(`[DEBUG] ranking global está VAZIO - rode /api/process para popular`);
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
            const visitInfo = ` (visita #${visitIndex + 1})`;
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

            // Verificar regras de in-app/iframe
            // utm_campaign pode vir da query string OU do path (/db/:campaignId)
            const utmCampaignDb = (req.query.utm_campaign as string) || (req.params.campaignId as string);
            if (utmCampaignDb) {
                const inAppRules = await this.getInAppRules();
                const inAppMatch = inAppRules.find(r => r.active && r.utm_campaign === utmCampaignDb);

                if (inAppMatch) {
                    const inAppUrl = new URL(inAppMatch.destination);
                    if (inAppMatch.passQueryParams) {
                        for (const [key, value] of Object.entries(req.query)) {
                            if (value) inAppUrl.searchParams.append(key, String(value));
                        }
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
                        console.log(`[INAPP REDIRECT DB] ${inAppMatch.id} campaign=${utmCampaignDb} -> ${finalUrl}`);
                        res.redirect(finalUrl);
                    } else {
                        // Não é in-app (Meta crawler, navegador normal) -> iframe
                        console.log(`[IFRAME DB] ${inAppMatch.id} campaign=${utmCampaignDb} -> ${finalUrl}`);
                        res.send(this.generateIframeHtml(finalUrl));
                    }
                    return;
                }
            }

            // Identificar visitante por IP
            const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                           req.socket.remoteAddress || 'unknown';

            // Contar visitas do visitante nesta hora (ranking global DB, sem dominio)
            const visitIndex = await this.getVisitorVisitCount(clientIp, 'db');

            // Buscar ranking global de links DB
            const globalRanking = await this.getBestLinksMapDb();

            let redirectUrl: string;
            let linkId: string;
            let logType: string;
            let domain: string;

            if (globalRanking && globalRanking.length > 0) {
                if (visitIndex < globalRanking.length) {
                    // Visita N -> pega o N-esimo melhor eCPM global
                    const linkInfo = globalRanking[visitIndex];
                    redirectUrl = linkInfo.url;
                    domain = linkInfo.domain;
                    linkId = `rank${visitIndex}_db_${domain}_${linkInfo.postId}`;
                    logType = `RANK #${visitIndex + 1} DB`;
                } else {
                    // Esgotou todos os links do ranking -> dominio aleatorio + /random
                    domain = domains_db[Math.floor(Math.random() * domains_db.length)];
                    redirectUrl = `https://${domain}${generateRandomPath()}`;
                    linkId = `random_db_${domain}`;
                    logType = 'RANDOM LINK DB';
                }
            } else {
                // Sem dados de ranking -> dominio aleatorio + /random
                domain = domains_db[Math.floor(Math.random() * domains_db.length)];
                redirectUrl = `https://${domain}${generateRandomPath()}`;
                linkId = `fallback_db_${domain}`;
                logType = 'RANDOM LINK DB';
                console.log(`[DEBUG-DB] ranking global DB está VAZIO - rode /api/process para popular`);
            }

            // domains_db não usa prefixo de idioma (/en/, /es/, etc)

            // Log
            const visitInfo = ` (visita #${visitIndex + 1})`;
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
            const globalRanking = await this.getBestLinksMap();
            const globalRankingDb = await this.getBestLinksMapDb();

            res.status(200).json({
                gam: gamStats,
                clicks: clickStats,
                traffic: {
                    totalDomains: domains.length,
                    totalDomainsDb: domains_db.length,
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
