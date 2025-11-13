import { Db, Collection, ObjectId } from 'mongodb';
import {
    IRedirectClick,
    ICreateRedirectClick,
    IUpdateRedirectClick
} from '../interfaces/redirect-click-interface';

export class RedirectClickRepository {
    private collection: Collection<IRedirectClick>;

    constructor(db: Db) {
        this.collection = db.collection<IRedirectClick>('redirects_clicks');
        // Criar índice único para link_id para garantir apenas um contador por link
        this.collection.createIndex({ link_id: 1 }, { unique: true });
    }

    /**
     * Incrementa o contador de clicks para um link
     * Se não existir, cria um novo registro com count = 1
     */
    async incrementClick(linkId: string): Promise<IRedirectClick> {
        const result = await this.collection.findOneAndUpdate(
            { link_id: linkId },
            {
                $inc: { count: 1 },
                $setOnInsert: {
                    created_at: new Date()
                }
            },
            {
                upsert: true,
                returnDocument: 'after'
            }
        );

        return result!;
    }

    /**
     * Obtém o contador de clicks para um link específico
     */
    async getClicksByLinkId(linkId: string): Promise<IRedirectClick | null> {
        return await this.collection.findOne({ link_id: linkId });
    }

    /**
     * Obtém o contador de clicks por ID do documento
     */
    async getClicksById(id: string): Promise<IRedirectClick | null> {
        try {
            return await this.collection.findOne({ _id: new ObjectId(id) });
        } catch (error) {
            return null;
        }
    }

    /**
     * Retorna o número total de clicks para um link
     */
    async getClickCount(linkId: string): Promise<number> {
        const result = await this.collection.findOne({ link_id: linkId });
        return result ? result.count : 0;
    }

    /**
     * Lista todos os contadores de clicks com paginação
     */
    async getAllClicks(limit: number = 10, offset: number = 0): Promise<IRedirectClick[]> {
        return await this.collection
            .find({})
            .skip(offset)
            .limit(limit)
            .sort({ count: -1 }) // Ordena por número de clicks (mais clicados primeiro)
            .toArray();
    }

    /**
     * Retorna os links mais clicados
     */
    async getTopClicks(limit: number = 10): Promise<IRedirectClick[]> {
        return await this.collection
            .find({})
            .sort({ count: -1 })
            .limit(limit)
            .toArray();
    }

    /**
     * Reseta o contador de clicks para um link
     */
    async resetClickCount(linkId: string): Promise<boolean> {
        const result = await this.collection.updateOne(
            { link_id: linkId },
            { $set: { count: 0 } }
        );
        return result.modifiedCount === 1;
    }

    /**
     * Define um valor específico para o contador
     */
    async setClickCount(linkId: string, count: number): Promise<boolean> {
        const result = await this.collection.updateOne(
            { link_id: linkId },
            {
                $set: { count: count },
                $setOnInsert: { created_at: new Date() }
            },
            { upsert: true }
        );
        return result.modifiedCount === 1 || result.upsertedCount === 1;
    }

    /**
     * Remove o contador de clicks para um link
     */
    async deleteClicksByLinkId(linkId: string): Promise<boolean> {
        const result = await this.collection.deleteOne({ link_id: linkId });
        return result.deletedCount === 1;
    }

    /**
     * Remove o contador por ID do documento
     */
    async deleteClicksById(id: string): Promise<boolean> {
        try {
            const result = await this.collection.deleteOne({ _id: new ObjectId(id) });
            return result.deletedCount === 1;
        } catch (error) {
            return false;
        }
    }

    /**
     * Conta o número total de documentos (links com clicks)
     */
    async countDocuments(): Promise<number> {
        return await this.collection.countDocuments();
    }

    /**
     * Retorna a soma total de todos os clicks no sistema
     */
    async getTotalClicksSum(): Promise<number> {
        const result = await this.collection.aggregate([
            { $group: { _id: null, total: { $sum: '$count' } } }
        ]).toArray();

        return result.length > 0 ? result[0].total : 0;
    }

    /**
     * Retorna estatísticas gerais
     */
    async getStats(): Promise<{
        totalLinks: number;
        totalClicks: number;
        averageClicksPerLink: number;
        maxClicks: number;
        minClicks: number;
    }> {
        const stats = await this.collection.aggregate([
            {
                $group: {
                    _id: null,
                    totalLinks: { $sum: 1 },
                    totalClicks: { $sum: '$count' },
                    averageClicks: { $avg: '$count' },
                    maxClicks: { $max: '$count' },
                    minClicks: { $min: '$count' }
                }
            }
        ]).toArray();

        if (stats.length === 0) {
            return {
                totalLinks: 0,
                totalClicks: 0,
                averageClicksPerLink: 0,
                maxClicks: 0,
                minClicks: 0
            };
        }

        return {
            totalLinks: stats[0].totalLinks,
            totalClicks: stats[0].totalClicks,
            averageClicksPerLink: Math.round(stats[0].averageClicks),
            maxClicks: stats[0].maxClicks,
            minClicks: stats[0].minClicks
        };
    }

    /**
     * Busca links com clicks dentro de um intervalo
     */
    async getClicksInRange(minClicks: number, maxClicks: number): Promise<IRedirectClick[]> {
        return await this.collection
            .find({
                count: { $gte: minClicks, $lte: maxClicks }
            })
            .sort({ count: -1 })
            .toArray();
    }

    /**
     * Incrementa clicks em lote para múltiplos links
     */
    async incrementMultipleClicks(linkIds: string[]): Promise<number> {
        let incrementedCount = 0;

        for (const linkId of linkIds) {
            const result = await this.collection.updateOne(
                { link_id: linkId },
                {
                    $inc: { count: 1 },
                    $setOnInsert: { created_at: new Date() }
                },
                { upsert: true }
            );

            if (result.modifiedCount === 1 || result.upsertedCount === 1) {
                incrementedCount++;
            }
        }

        return incrementedCount;
    }
}
