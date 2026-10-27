import { dropRandomPlaceholders, RankedLinksList } from './interleave-by-domain';

/** Teto de latência que o fallback do Mongo pode somar a UMA request (a leitura segue em voo). */
export const LAST_RANKING_TIMEOUT_MS = 500;
/** Backoff após erro do Mongo: evita reconsultar a cada request enquanto ele está degradado. */
export const LAST_RANKING_ERROR_BACKOFF_MS = 10_000;
/** Cache negativo quando o Mongo responde mas não há lastRanking para o slug. */
export const LAST_RANKING_MISS_TTL_MS = 60_000;
/** TTL do cache em memória do ranking (igual ao histórico do controller). */
export const RANKING_MEMORY_TTL_MS = 60_000;

export interface PersistedRanking {
    ranking: RankedLinksList;
    at: Date | null;
}

export interface RankingResolverDeps {
    /** Valor cru da chave do ranking no Redis (null = ausente). Lança se o Redis está indisponível. */
    getRedis: (slug: string) => Promise<string | null>;
    /** Último ranking persistido no Mongo (null = nunca houve). */
    loadMongo: (slug: string) => Promise<PersistedRanking | null>;
    /** Re-semeia o Redis (o controller usa SET ... EX 3600 NX). Pode lançar: é best-effort. */
    seedRedis: (slug: string, ranking: RankedLinksList) => Promise<void>;
    now: () => number;
}

export interface RankingResolverOptions {
    memoryTtlMs?: number;
    timeoutMs?: number;
    errorBackoffMs?: number;
    missTtlMs?: number;
}

/**
 * Cadeia de serving do ranking de um grupo: cache em memória -> Redis -> último ranking do Mongo.
 * Regra de negócio: o destino é "home" só quando NÃO há dado em lugar nenhum. Por isso o Mongo
 * também é consultado quando o Redis está vazio, indisponível (get lança) ou só tem itens
 * `random` legados. Se nada serve, devolve o último cache em memória (mesmo vencido) ou null.
 *
 * Mongo: single-flight por slug (uma leitura compartilhada), cache negativo para "sem dado" e
 * backoff curto para erro; a latência somada a uma request é limitada por `timeoutMs` — estourou,
 * essa request recebe o fallback e a leitura em voo termina e popula o cache para as próximas.
 */
export class RankingResolver {
    private cache = new Map<string, { data: RankedLinksList; time: number }>();
    private inflight = new Map<string, Promise<RankedLinksList | null>>();
    private retryAfter = new Map<string, number>();
    private logged = new Set<string>();

    private readonly memoryTtlMs: number;
    private readonly timeoutMs: number;
    private readonly errorBackoffMs: number;
    private readonly missTtlMs: number;

    constructor(private readonly deps: RankingResolverDeps, opts: RankingResolverOptions = {}) {
        this.memoryTtlMs = opts.memoryTtlMs ?? RANKING_MEMORY_TTL_MS;
        this.timeoutMs = opts.timeoutMs ?? LAST_RANKING_TIMEOUT_MS;
        this.errorBackoffMs = opts.errorBackoffMs ?? LAST_RANKING_ERROR_BACKOFF_MS;
        this.missTtlMs = opts.missTtlMs ?? LAST_RANKING_MISS_TTL_MS;
    }

    async get(slug: string): Promise<RankedLinksList | null> {
        const cached = this.cache.get(slug);
        if (cached && this.deps.now() - cached.time < this.memoryTtlMs) return cached.data;

        try {
            const raw = await this.deps.getRedis(slug);
            if (raw) {
                this.logged.delete(slug);
                // Defesa contra ranking legado com itens `random` (salvo antes da regra que proíbe a rota random).
                const parsed = dropRandomPlaceholders(JSON.parse(raw) as RankedLinksList);
                if (parsed.length > 0) {
                    this.cache.set(slug, { data: parsed, time: this.deps.now() });
                    return parsed;
                }
                // Só random legado: trata como vazio e tenta o Mongo.
            }
        } catch (error) {
            console.error(`Error getting best links map for group ${slug}:`, error);
        }

        return this.fromMongo(slug, cached?.data ?? null);
    }

    private async fromMongo(slug: string, fallback: RankedLinksList | null): Promise<RankedLinksList | null> {
        const retryAt = this.retryAfter.get(slug);
        if (retryAt !== undefined && this.deps.now() < retryAt) return fallback;

        let flight = this.inflight.get(slug);
        if (!flight) {
            flight = this.load(slug).finally(() => this.inflight.delete(slug));
            this.inflight.set(slug, flight);
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
        });
        try {
            const result = await Promise.race([flight, timeout]);
            return result === 'timeout' ? fallback : (result ?? fallback);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Leitura real do Mongo + efeitos (cache, log, re-seed). Nunca rejeita. */
    private async load(slug: string): Promise<RankedLinksList | null> {
        try {
            const persisted = await this.deps.loadMongo(slug);
            const ranking = persisted ? dropRandomPlaceholders(persisted.ranking) : [];
            if (!persisted || ranking.length === 0) {
                this.retryAfter.set(slug, this.deps.now() + this.missTtlMs);
                return null;
            }
            this.retryAfter.delete(slug);
            this.cache.set(slug, { data: ranking, time: this.deps.now() });
            if (!this.logged.has(slug)) {
                this.logged.add(slug);
                console.log(`[RANKING-${slug.toUpperCase()}] Redis vazio — usando lastRanking do Mongo (${persisted.at ? persisted.at.toISOString() : 'sem data'}), ${ranking.length} links`);
            }
            try {
                await this.deps.seedRedis(slug, ranking);
            } catch (err) {
                console.error(`[RANKING-${slug.toUpperCase()}] Erro ao re-semear Redis com lastRanking:`, err);
            }
            return ranking;
        } catch (err) {
            this.retryAfter.set(slug, this.deps.now() + this.errorBackoffMs);
            console.error(`[RANKING-${slug.toUpperCase()}] Erro ao ler lastRanking do Mongo:`, err);
            return null;
        }
    }
}
