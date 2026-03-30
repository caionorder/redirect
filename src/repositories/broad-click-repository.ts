import { Db, Collection } from 'mongodb';
import { IBroadClick } from '../interfaces/broad-click-interface';

export class BroadClickRepository {
    private collection: Collection<IBroadClick>;

    constructor(db: Db) {
        this.collection = db.collection<IBroadClick>('broad_clicks');
        // Criar índice composto único para broad_id + date
        this.collection.createIndex({ broad_id: 1, date: 1 }, { unique: true });
    }

    /**
     * Incrementa o contador de clicks para um broad em uma data específica.
     * Se não existir, cria um novo registro com count = 1.
     */
    async incrementClick(broadId: string): Promise<IBroadClick> {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

        const result = await this.collection.findOneAndUpdate(
            { broad_id: broadId, date: today },
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
     * Retorna clicks agregados por broad_id, filtrável por intervalo de datas.
     * Se apenas start for fornecido, filtra essa data exata.
     * Se start e end forem fornecidos, filtra o intervalo.
     */
    async getClicks(start?: string, end?: string): Promise<{ broad_id: string; total_clicks: number }[]> {
        const matchStage: any = {};

        if (start && end) {
            matchStage.date = { $gte: start, $lte: end };
        } else if (start) {
            matchStage.date = start;
        }

        const pipeline: any[] = [];

        if (Object.keys(matchStage).length > 0) {
            pipeline.push({ $match: matchStage });
        }

        pipeline.push(
            {
                $group: {
                    _id: '$broad_id',
                    total_clicks: { $sum: '$count' }
                }
            },
            {
                $project: {
                    _id: 0,
                    broad_id: '$_id',
                    total_clicks: 1
                }
            },
            {
                $sort: { total_clicks: -1 }
            }
        );

        return await this.collection.aggregate<{ broad_id: string; total_clicks: number }>(pipeline).toArray();
    }
}
