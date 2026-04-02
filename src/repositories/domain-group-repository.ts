import { Db, Collection } from 'mongodb';
import { IDomainGroup, ICreateDomainGroup, domainGroupCollectionName } from '../schemas/domain-group-schema';

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
        return this.collection.find({}).sort({ createdAt: -1 }).toArray();
    }

    async findBySlug(slug: string): Promise<IDomainGroup | null> {
        return this.collection.findOne({ slug });
    }

    async findActiveGroups(): Promise<IDomainGroup[]> {
        return this.collection.find({ active: true }).toArray();
    }

    async create(data: ICreateDomainGroup): Promise<IDomainGroup> {
        const now = new Date();
        const document: Omit<IDomainGroup, '_id'> = {
            slug: data.slug,
            name: data.name,
            domains: data.domains || [],
            active: true,
            createdAt: now,
            updatedAt: now,
        };

        const result = await this.collection.insertOne(document);
        return { ...document, _id: result.insertedId };
    }

    async updateBySlug(slug: string, update: { slug?: string; name?: string }): Promise<IDomainGroup | null> {
        const setFields: Record<string, unknown> = { updatedAt: new Date() };
        if (update.name) setFields.name = update.name;
        if (update.slug) setFields.slug = update.slug;

        const result = await this.collection.findOneAndUpdate(
            { slug },
            { $set: setFields },
            { returnDocument: 'after' }
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
            { returnDocument: 'after' }
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
            { returnDocument: 'after' }
        );
        return result ?? null;
    }

    async count(): Promise<number> {
        return this.collection.countDocuments();
    }
}
