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
     * Salva no Redis uma lista: [{ url, domain, postId, ecpm }, ...]
     */
    private async executeProcessForGroup(slug: string): Promise<RankedLinksList | null> {
        const groupDomains = await this.domainGroupService.getDomains(slug);
        if (groupDomains.length === 0) {
            console.log(`[CRON-${slug.toUpperCase()}] Nenhum domínio configurado`);
            return null;
        }

        const date = new Date();
        const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());

        const filterRequest: IFilterRequest = {
            start: today.toISOString().split('T')[0],
            end: today.toISOString().split('T')[0],
            domain: groupDomains,
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

        // Criar lista global de todos os links
        const globalRanking: RankedLinksList = [];

        let skipped = 0;
        for (const item of data) {
            if (!item.domain || !item.custom_value) continue;

            const impressions = Number(item.impressions || 0);
            if (impressions < 500) {
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

        // Validar posts via API WordPress ANTES de intercalar (senão /random seria removido)
        const validatedRanking = await this.validateRanking(globalRanking);

        // Intercalar domínios (round-robin) — domínios sem dados entram como /random
        const interleavedRanking = this.interleaveByDomain(validatedRanking, groupDomains);

        // Pegar apenas os top 20 melhores eCPM (já intercalado com round-robin)
        const topRanking = interleavedRanking.slice(0, 50);

        // Salvar no cache Redis (1 hora)
        const redisKey = this.getRedisKeyForGroup(slug);
        if (this.redisClient && topRanking.length > 0) {
            await this.redisClient.set(
                redisKey,
                JSON.stringify(topRanking),
                'EX',
                3600
            );
            console.log(`[CRON-${slug.toUpperCase()}] Ranking global atualizado: ${topRanking.length} links no rank (${validatedRanking.length} validados, ${skipped} ignorados por <500 impressões)`);
        }

        // Log do top 5
        const top = topRanking.slice(0, 5);
        for (let i = 0; i < top.length; i++) {
            console.log(`[CRON-${slug.toUpperCase()}] #${i + 1} ${top[i].domain} p=${top[i].postId} (eCPM: ${top[i].ecpm.toFixed(4)})`);
        }

        return topRanking;
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
                        ecpm: 0
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
     * Retorna a lista de domínios já visitados pelo IP nesta hora.
     */
    private async getVisitorVisitCount(ip: string, type: string): Promise<number> {
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
     * Adiciona um domínio à lista de visitados e define TTL de 1h na primeira inserção.
     */
    private async addVisitedDomain(ip: string, type: 'main' | 'db', domain: string): Promise<void> {
        if (!this.redisClient) return;
        const key = this.getVisitorKey(ip, type);
        const added = await this.redisClient.sadd(key, domain);
        // Se foi o primeiro elemento adicionado, setar TTL
        if (added === 1) {
            const ttl = await this.redisClient.ttl(key);
            if (ttl === -1) {
                await this.redisClient.expire(key, 3600);
            }
        }
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
                // Esgotou o ranking -> volta pro primeiro (ciclo)
                const idx = visitIndex % globalRanking.length;
                const linkInfo = globalRanking[idx];
                redirectUrl = linkInfo.url;
                domain = linkInfo.domain;
                linkId = `rank${idx}_${domain}_${linkInfo.postId}`;
                logType = `RANK #${idx + 1}`;
            } else {
                // Sem dados de ranking -> dominio aleatorio + /random
                const mainDomains = await this.domainGroupService.getDomains('main');
                domain = mainDomains[Math.floor(Math.random() * mainDomains.length)];
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

            // Registrar click
            if (linkId && this.redirectClickRepository) {
                this.redirectClickRepository.incrementClick(linkId)
                    .then(result => console.log(`[CLICK RECORDED] LinkID: ${linkId}, New Count: ${result.count}`))
                    .catch(() => {});
            }
            if (broad && this.broadClickRepository) {
                this.broadClickRepository.incrementClick(broad)
                    .then(result => console.log(`[CLICK RECORDED BROAD] ${broad}, New Count: ${result.count}`))
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
                        for (const [key, value] of Object.entries(req.query)) {
                            if (value) inAppUrl.searchParams.append(key, String(value));
                        }
                        if (req.params.campaignId) {
                            inAppUrl.searchParams.append('utm_campaign', String(req.params.campaignId));
                        }
                    }
                    const finalUrl = inAppUrl.toString();
                    const userAgent = req.headers['user-agent'] || '';
                    const isInApp = this.isInAppBrowser(userAgent);

                    if (isInApp) {
                        console.log(`[INAPP REDIRECT ${slug.toUpperCase()}] ${inAppMatch.id} campaign=${utmCampaign} -> ${finalUrl}`);
                        res.redirect(finalUrl);
                    } else {
                        console.log(`[IFRAME ${slug.toUpperCase()}] ${inAppMatch.id} campaign=${utmCampaign} -> ${finalUrl}`);
                        res.send(this.generateIframeHtml(finalUrl));
                    }
                    return;
                }
            }

            // Identificar visitante por IP
            const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                           req.socket.remoteAddress || 'unknown';

            // Contar visitas do visitante nesta hora
            const visitIndex = await this.getVisitorVisitCount(clientIp, slug);

            // Buscar ranking global de links do grupo
            const globalRanking = await this.getBestLinksMapForGroup(slug);

            let redirectUrl: string;
            let linkId: string;
            let logType: string;
            let domain: string;

            if (globalRanking && globalRanking.length > 0) {
                // Esgotou o ranking -> volta pro primeiro (ciclo)
                const idx = visitIndex % globalRanking.length;
                const linkInfo = globalRanking[idx];
                redirectUrl = linkInfo.url;
                domain = linkInfo.domain;
                linkId = `rank${idx}_${slug}_${domain}_${linkInfo.postId}`;
                logType = `RANK #${idx + 1} ${slug.toUpperCase()}`;
            } else {
                // Sem dados de ranking -> dominio aleatorio + /random
                domain = groupDomains[Math.floor(Math.random() * groupDomains.length)];
                redirectUrl = `https://${domain}${generateRandomPath()}`;
                linkId = `fallback_${slug}_${domain}`;
                logType = `RANDOM LINK ${slug.toUpperCase()}`;
                console.log(`[DEBUG-${slug.toUpperCase()}] ranking global está VAZIO - rode /api/process para popular`);
            }

            // Log
            const visitInfo = ` (visita #${visitIndex + 1})`;
            console.log(`[${logType}] ${domain}${visitInfo} -> ${redirectUrl}`);

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

            // Registrar click
            if (linkId && this.redirectClickRepository) {
                this.redirectClickRepository.incrementClick(linkId)
                    .then(result => console.log(`[CLICK RECORDED ${slug.toUpperCase()}] LinkID: ${linkId}, New Count: ${result.count}`))
                    .catch(() => {});
            }
            if (broad && this.broadClickRepository) {
                this.broadClickRepository.incrementClick(broad)
                    .then(result => console.log(`[CLICK RECORDED BROAD ${slug.toUpperCase()}] ${broad}, New Count: ${result.count}`))
                    .catch(() => {});
            }

            // Cache anti-duplicacao (fire and forget)
            if (this.redisClient) {
                this.redisClient.set(`recent:${clientIp}`, finalRedirectUrl, 'EX', 5).catch(() => {});
            }

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
