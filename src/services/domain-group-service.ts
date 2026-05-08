import { Db } from 'mongodb';
import { DomainGroupRepository } from '../repositories/domain-group-repository';
import { IDomainGroup, ICreateDomainGroup } from '../schemas/domain-group-schema';
import { domains as seedDomains, domains_db as seedDomainsDb } from '../config/domains';

export class DomainGroupService {
    private repository: DomainGroupRepository;
    private cache: Map<string, string[]> = new Map();
    private groupConfigCache: Map<string, IDomainGroup> = new Map();
    private allGroupsCache: IDomainGroup[] = [];
    private activeSlugsArrayCache: string[] = [];
    private cacheTime: number = 0;
    private readonly CACHE_TTL_MS = 60000; // 1 minuto

    private static instance: DomainGroupService | null = null;

    constructor(db: Db) {
        this.repository = new DomainGroupRepository(db);
    }

    /**
     * Singleton para compartilhar a mesma instancia entre app.ts e controllers
     */
    static getInstance(db?: Db): DomainGroupService {
        if (!DomainGroupService.instance && db) {
            DomainGroupService.instance = new DomainGroupService(db);
        }
        if (!DomainGroupService.instance) {
            throw new Error('DomainGroupService not initialized. Call getInstance(db) first.');
        }
        return DomainGroupService.instance;
    }

    /**
     * Seed: se a collection estiver vazia, popula com os dados estaticos
     */
    async seed(): Promise<void> {
        const count = await this.repository.count();
        if (count > 0) {
            console.log(`[DomainGroupService] ${count} groups already exist, skipping seed`);
            await this.refreshCache();
            return;
        }

        console.log('[DomainGroupService] Seeding domain groups...');

        await this.repository.create({
            slug: 'main',
            name: 'Main Domains',
            domains: [...seedDomains],
        });

        await this.repository.create({
            slug: 'db',
            name: 'DB Domains',
            domains: [...seedDomainsDb],
        });

        console.log('[DomainGroupService] Seed completed: main + db');
        await this.refreshCache();
    }

    /**
     * Atualiza o cache em memoria a partir do MongoDB
     */
    async refreshCache(): Promise<void> {
        try {
            const groups = await this.repository.findActiveGroups();
            this.cache.clear();
            this.groupConfigCache.clear();
            for (const group of groups) {
                this.cache.set(group.slug, group.domains);
                this.groupConfigCache.set(group.slug, group);
            }
            this.allGroupsCache = await this.repository.findAll();
            this.activeSlugsArrayCache = Array.from(this.cache.keys());
            this.cacheTime = Date.now();
        } catch (error) {
            console.error('[DomainGroupService] Error refreshing cache:', error);
        }
    }

    /**
     * Garante que o cache foi carregado (só na primeira vez).
     * Depois só atualiza via refreshCache() chamado pelos métodos de mutação.
     */
    private async ensureCache(): Promise<void> {
        if (this.cacheTime === 0) {
            await this.refreshCache();
        }
    }

    /**
     * Retorna a config completa de um grupo pelo slug (usa cache).
     */
    async getGroupConfig(slug: string): Promise<IDomainGroup | null> {
        await this.ensureCache();
        return this.groupConfigCache.get(slug) || null;
    }

    /**
     * Retorna dominios de um grupo pelo slug.
     * Fallback para arrays estaticos se cache estiver vazio.
     */
    async getDomains(slug: string): Promise<string[]> {
        await this.ensureCache();
        const domains = this.cache.get(slug);
        if (domains) return domains;

        // Fallback para dados estaticos
        if (slug === 'main') return [...seedDomains];
        if (slug === 'db') return [...seedDomainsDb];
        return [];
    }

    /**
     * Retorna todos os slugs de grupos ativos
     */
    async getActiveSlugs(): Promise<string[]> {
        await this.ensureCache();
        return Array.from(this.cache.keys());
    }

    /**
     * Versao sincrona de getActiveSlugs. Usa array memoizado.
     * Pre-condicao: cache ja foi populado (refreshCache chamado pelo seed() no boot).
     * Em hot path, evita microtask por request.
     */
    getActiveSlugsSync(): string[] {
        return this.activeSlugsArrayCache;
    }

    /**
     * Retorna todos os dominios de todos os grupos ativos (para CSP headers)
     */
    async getAllDomains(): Promise<string[]> {
        await this.ensureCache();
        const allDomains: string[] = [];
        for (const domains of this.cache.values()) {
            allDomains.push(...domains);
        }
        return allDomains;
    }

    /**
     * Retorna todos os grupos (para listagem)
     */
    async getAllGroups(): Promise<IDomainGroup[]> {
        await this.ensureCache();
        return this.allGroupsCache;
    }

    /**
     * Cria um novo grupo
     */
    async createGroup(data: ICreateDomainGroup): Promise<IDomainGroup> {
        const group = await this.repository.create(data);
        await this.refreshCache();
        return group;
    }

    /**
     * Deleta um grupo pelo slug
     */
    async updateGroup(slug: string, update: { slug?: string; name?: string; bestRpsMode?: boolean }): Promise<IDomainGroup | null> {
        const group = await this.repository.updateBySlug(slug, update);
        if (group) {
            await this.refreshCache();
        }
        return group;
    }

    async deleteGroup(slug: string): Promise<boolean> {
        const deleted = await this.repository.deleteBySlug(slug);
        if (deleted) {
            await this.refreshCache();
        }
        return deleted;
    }

    /**
     * Adiciona dominios a um grupo
     */
    async addDomains(slug: string, domains: string[]): Promise<IDomainGroup | null> {
        const group = await this.repository.addDomains(slug, domains);
        if (group) {
            await this.refreshCache();
        }
        return group;
    }

    /**
     * Remove dominios de um grupo
     */
    async removeDomains(slug: string, domains: string[]): Promise<IDomainGroup | null> {
        const group = await this.repository.removeDomains(slug, domains);
        if (group) {
            await this.refreshCache();
        }
        return group;
    }
}
