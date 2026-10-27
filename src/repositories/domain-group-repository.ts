import { Db, Collection } from 'mongodb';
import { RankedLinksList } from '../utils/interleave-by-domain';
import { IDomainGroup, ICreateDomainGroup, domainGroupCollectionName } from '../schemas/domain-group-schema';

/** Projeção das leituras "de config": o ranking persistido (e sua data) é interno e não deve inflar cache/API. */
const WITHOUT_LAST_RANKING = { lastRanking: 0, lastRankingAt: 0 } as const;

export class DomainGroupRepository {
    private collection: Collection<IDomainGroup>;

    constructor(db: Db) {
        this.collection = db.collection<IDomainGroup>(domainGroupCollectionName);
        this.ensureIndexes();
    }

    private async ensureIndexes(): Promise<void> {
        try {
            await this.collection.createIndex({ slug: 1 }, { unique: true });
        } catch (error) {
            console.error('[DomainGroupRepository] Error creating indexes:', error);
        }
    }

    async findAll(): Promise<IDomainGroup[]> {
        return this.collection.find({}, { projection: WITHOUT_LAST_RANKING }).sort({ createdAt: -1 }).toArray();
    }

    async findBySlug(slug: string): Promise<IDomainGroup | null> {
        return this.collection.findOne({ slug }, { projection: WITHOUT_LAST_RANKING });
    }

    /**
     * Persiste o último ranking válido do grupo (sobrevive ao wipe do Redis no deploy).
     * `$set` pontual por slug — não toca updatedAt (não é edição de config) nem cria documento.
     */
    async saveLastRanking(slug: string, ranking: RankedLinksList): Promise<void> {
        await this.collection.updateOne(
            { slug },
            { $set: { lastRanking: ranking, lastRankingAt: new Date() } }
        );
    }

    /** Lê só o ranking persistido (projeção) — usado no serving quando o Redis está vazio. */
    async findLastRanking(slug: string): Promise<{ ranking: RankedLinksList; at: Date | null } | null> {
        const doc = await this.collection.findOne(
            { slug },
            { projection: { _id: 0, lastRanking: 1, lastRankingAt: 1 } }
        );
        if (!doc || !Array.isArray(doc.lastRanking) || doc.lastRanking.length === 0) return null;
        return { ranking: doc.lastRanking, at: doc.lastRankingAt ?? null };
    }

    async findActiveGroups(): Promise<IDomainGroup[]> {
        return this.collection.find({ active: true }, { projection: WITHOUT_LAST_RANKING }).toArray();
    }

    async create(data: ICreateDomainGroup): Promise<IDomainGroup> {
        const now = new Date();
        const document: Omit<IDomainGroup, '_id'> = {
            slug: data.slug,
            name: data.name,
            domains: data.domains || [],
            active: true,
            bestRpsMode: false,
            ...(data.fixedPath ? { fixedPath: data.fixedPath } : {}),
            createdAt: now,
            updatedAt: now,
        };

        const result = await this.collection.insertOne(document);
        return { ...document, _id: result.insertedId };
    }

    async updateBySlug(slug: string, update: { slug?: string; name?: string; bestRpsMode?: boolean; fixedPath?: string | null }): Promise<IDomainGroup | null> {
        const setFields: Record<string, unknown> = { updatedAt: new Date() };
        if (update.name) setFields.name = update.name;
        if (update.slug) setFields.slug = update.slug;
        if (typeof update.bestRpsMode === 'boolean') setFields.bestRpsMode = update.bestRpsMode;
        if (typeof update.fixedPath === 'string') setFields.fixedPath = update.fixedPath;

        const updateOps: { $set: Record<string, unknown>; $unset?: Record<string, ''> } = { $set: setFields };
        // fixedPath === null remove o campo (volta ao comportamento padrão de ranking)
        if (update.fixedPath === null) updateOps.$unset = { fixedPath: '' };

        const result = await this.collection.findOneAndUpdate(
            { slug },
            updateOps,
            { returnDocument: 'after', projection: WITHOUT_LAST_RANKING }
        );
        return result ?? null;
    }

    async deleteBySlug(slug: string): Promise<boolean> {
        const result = await this.collection.deleteOne({ slug });
        return result.deletedCount === 1;
    }

    async addDomains(slug: string, domains: string[]): Promise<IDomainGroup | null> {
        const result = await this.collection.findOneAndUpdate(
            { slug },
            {
                $addToSet: { domains: { $each: domains } },
                $set: { updatedAt: new Date() },
            },
            { returnDocument: 'after', projection: WITHOUT_LAST_RANKING }
        );
        return result ?? null;
    }

    async removeDomains(slug: string, domains: string[]): Promise<IDomainGroup | null> {
        const result = await this.collection.findOneAndUpdate(
            { slug },
            {
                $pull: { domains: { $in: domains } } as Record<string, unknown>,
                $set: { updatedAt: new Date() },
            },
            { returnDocument: 'after', projection: WITHOUT_LAST_RANKING }
        );
        return result ?? null;
    }

    async count(): Promise<number> {
        return this.collection.countDocuments();
    }
}
