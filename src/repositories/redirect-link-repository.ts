import { Db, Collection, ObjectId } from 'mongodb';
import { IRedirectLink, ICreateRedirectLink, IUpdateRedirectLink } from '../interfaces/redirect-link-interface';

export class RedirectLinkRepository {
    private collection: Collection<IRedirectLink>;

    constructor(db: Db) {
        this.collection = db.collection<IRedirectLink>('redirects_links');
    }

    async createLink(linkData: ICreateRedirectLink): Promise<ObjectId> {
        const now = new Date();
        const document: Omit<IRedirectLink, '_id'> = {
            ...linkData,
            created_at: now,
            updated_at: now
        };

        const result = await this.collection.insertOne(document);
        return result.insertedId;
    }

    async getLinkById(id: string): Promise<IRedirectLink | null> {
        try {
            return await this.collection.findOne({ _id: new ObjectId(id) });
        } catch (error) {
            // Se o ID for inválido, retorna null
            return null;
        }
    }

    async getLinkByDomainAndUrl(domain: string, url: string): Promise<IRedirectLink | null> {
        return await this.collection.findOne({ domain, url });
    }

    async updateLink(id: string, updateData: IUpdateRedirectLink): Promise<boolean> {
        try {
            const result = await this.collection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { ...updateData, updated_at: new Date() } }
            );
            return result.modifiedCount === 1;
        } catch (error) {
            // Se o ID for inválido ou houver erro, retorna false
            return false;
        }
    }

    async deleteLink(id: string): Promise<boolean> {
        try {
            const result = await this.collection.deleteOne({ _id: new ObjectId(id) });
            return result.deletedCount === 1;
        } catch (error) {
            // Se o ID for inválido ou houver erro, retorna false
            return false;
        }
    }

    async getAllLinks(limit: number = 10, offset: number = 0): Promise<IRedirectLink[]> {
        return await this.collection
            .find({})
            .skip(offset)
            .limit(limit)
            .sort({ created_at: -1 })
            .toArray();
    }

    async countLinks(): Promise<number> {
        return await this.collection.countDocuments();
    }

    async getLinksByDomain(domain: string): Promise<IRedirectLink[]> {
        return await this.collection
            .find({ domain })
            .sort({ created_at: -1 })
            .toArray();
    }
}
