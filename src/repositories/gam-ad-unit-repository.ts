import { Db, Collection, ObjectId, AggregateOptions } from 'mongodb';
import {
    IGamAdUnitKeyValue,
    IGamAdUnitQuery
} from '../interfaces/gam-ad-unit-interface';
import { IRepository } from '../interfaces/filter-interfaces';

/**
 * Repositório READ-ONLY para a collection gam_ad_unit_key_values
 * Apenas operações de leitura são permitidas
 */
export class GamAdUnitRepository implements IRepository {
    private collection: Collection<IGamAdUnitKeyValue>;
    private db: Db;

    constructor(db: Db) {
        this.db = db;
        this.collection = db.collection<IGamAdUnitKeyValue>('gam_ad_unit_key_values');
    }

    /**
     * Implementação do método query para IRepository
     * Retorna a collection para uso em agregações
     */
    query(): Collection<IGamAdUnitKeyValue> {
        return this.collection;
    }

    /**
     * Buscar por ID (READ-ONLY)
     */
    async findById(id: string): Promise<IGamAdUnitKeyValue | null> {
        try {
            return await this.collection.findOne({ _id: new ObjectId(id) });
        } catch (error) {
            console.error('Error finding document by ID:', error);
            return null;
        }
    }

    /**
     * Buscar por query (READ-ONLY)
     */
    async findByQuery(query: IGamAdUnitQuery, limit: number = 100, skip: number = 0): Promise<IGamAdUnitKeyValue[]> {
        const filter: any = {};

        // Filtro por data
        if (query.start || query.end) {
            filter.date = {};
            if (query.start) filter.date.$gte = query.start;
            if (query.end) filter.date.$lte = query.end;
        }

        // Filtro por domain
        if (query.domain) {
            if (Array.isArray(query.domain)) {
                filter.domain = { $in: query.domain };
            } else {
                filter.domain = query.domain;
            }
        }

        // Outros filtros
        if (query.network) filter.network = query.network;
        if (query.country) filter.country = query.country;
        if (query.custom_key) filter.custom_key = query.custom_key;

        // Filtro por custom_value
        if (query.custom_value) {
            if (Array.isArray(query.custom_value)) {
                filter.custom_value = { $in: query.custom_value };
            } else {
                filter.custom_value = query.custom_value;
            }
        }

        // Filtro por ad_unit_name (usando regex para busca parcial)
        if (query.ad_unit_name) {
            filter.ad_unit_name = { $regex: query.ad_unit_name, $options: 'i' };
        }

        return await this.collection
            .find(filter)
            .skip(skip)
            .limit(limit)
            .sort({ date: -1, revenue: -1 })
            .toArray();
    }

    /**
     * Contar documentos (READ-ONLY)
     */
    async count(query: IGamAdUnitQuery = {}): Promise<number> {
        const filter: any = {};

        if (query.start || query.end) {
            filter.date = {};
            if (query.start) filter.date.$gte = query.start;
            if (query.end) filter.date.$lte = query.end;
        }

        if (query.domain) {
            if (Array.isArray(query.domain)) {
                filter.domain = { $in: query.domain };
            } else {
                filter.domain = query.domain;
            }
        }

        if (query.network) filter.network = query.network;
        if (query.country) filter.country = query.country;
        if (query.custom_key) filter.custom_key = query.custom_key;

        if (query.custom_value) {
            if (Array.isArray(query.custom_value)) {
                filter.custom_value = { $in: query.custom_value };
            } else {
                filter.custom_value = query.custom_value;
            }
        }

        return await this.collection.countDocuments(filter);
    }

    /**
     * Agregação customizada (READ-ONLY)
     * Usado pelo SuperFilterService
     */
    async aggregate(pipeline: any[], options?: AggregateOptions): Promise<any[]> {
        return await this.collection.aggregate(pipeline, options).toArray();
    }

    /**
     * Buscar valores únicos de um campo (READ-ONLY)
     */
    async getDistinctValues(field: keyof IGamAdUnitKeyValue, query: IGamAdUnitQuery = {}): Promise<any[]> {
        const filter: any = {};

        if (query.start || query.end) {
            filter.date = {};
            if (query.start) filter.date.$gte = query.start;
            if (query.end) filter.date.$lte = query.end;
        }

        if (query.domain) {
            if (Array.isArray(query.domain)) {
                filter.domain = { $in: query.domain };
            } else {
                filter.domain = query.domain;
            }
        }

        if (query.network) filter.network = query.network;
        if (query.country) filter.country = query.country;

        return await this.collection.distinct(field as string, filter);
    }

    /**
     * Obter estatísticas gerais (READ-ONLY)
     */
    async getStats(query: IGamAdUnitQuery = {}): Promise<{
        totalRecords: number;
        totalImpressions: number;
        totalClicks: number;
        totalRevenue: number;
        avgEcpm: number;
        avgCtr: number;
        dateRange?: {
            start: string;
            end: string;
        };
    }> {
        const filter: any = {};

        if (query.start || query.end) {
            filter.date = {};
            if (query.start) filter.date.$gte = query.start;
            if (query.end) filter.date.$lte = query.end;
        }

        if (query.domain) {
            if (Array.isArray(query.domain)) {
                filter.domain = { $in: query.domain };
            } else {
                filter.domain = query.domain;
            }
        }

        if (query.network) filter.network = query.network;
        if (query.country) filter.country = query.country;

        const pipeline = [
            { $match: filter },
            {
                $group: {
                    _id: null,
                    totalRecords: { $sum: 1 },
                    totalImpressions: { $sum: { $toDouble: { $ifNull: ['$impressions', 0] } } },
                    totalClicks: { $sum: { $toDouble: { $ifNull: ['$clicks', 0] } } },
                    totalRevenue: { $sum: { $toDouble: { $ifNull: ['$revenue', 0] } } },
                    minDate: { $min: '$date' },
                    maxDate: { $max: '$date' }
                }
            }
        ];

        const results = await this.collection.aggregate(pipeline).toArray();

        if (results.length === 0) {
            return {
                totalRecords: 0,
                totalImpressions: 0,
                totalClicks: 0,
                totalRevenue: 0,
                avgEcpm: 0,
                avgCtr: 0
            };
        }

        const stats = results[0];
        const avgEcpm = stats.totalImpressions > 0
            ? (stats.totalRevenue / stats.totalImpressions) * 1000
            : 0;
        const avgCtr = stats.totalImpressions > 0
            ? (stats.totalClicks / stats.totalImpressions) * 100
            : 0;

        const result: any = {
            totalRecords: stats.totalRecords,
            totalImpressions: Math.floor(stats.totalImpressions),
            totalClicks: Math.floor(stats.totalClicks),
            totalRevenue: Math.round(stats.totalRevenue * 100) / 100,
            avgEcpm: Math.round(avgEcpm * 100) / 100,
            avgCtr: Math.round(avgCtr * 100) / 100
        };

        // Adicionar range de datas se disponível
        if (stats.minDate && stats.maxDate) {
            result.dateRange = {
                start: stats.minDate,
                end: stats.maxDate
            };
        }

        return result;
    }

    /**
     * Obter dados agrupados por período (READ-ONLY)
     */
    async getDataByPeriod(
        query: IGamAdUnitQuery = {},
        groupBy: 'day' | 'week' | 'month' = 'day'
    ): Promise<any[]> {
        const filter: any = {};

        if (query.start || query.end) {
            filter.date = {};
            if (query.start) filter.date.$gte = query.start;
            if (query.end) filter.date.$lte = query.end;
        }

        if (query.domain) {
            if (Array.isArray(query.domain)) {
                filter.domain = { $in: query.domain };
            } else {
                filter.domain = query.domain;
            }
        }

        const dateFormat = {
            day: '%Y-%m-%d',
            week: '%Y-W%V',
            month: '%Y-%m'
        };

        const pipeline = [
            { $match: filter },
            {
                $group: {
                    _id: {
                        $dateToString: {
                            format: dateFormat[groupBy],
                            date: { $dateFromString: { dateString: '$date' } }
                        }
                    },
                    impressions: { $sum: { $toDouble: { $ifNull: ['$impressions', 0] } } },
                    clicks: { $sum: { $toDouble: { $ifNull: ['$clicks', 0] } } },
                    revenue: { $sum: { $toDouble: { $ifNull: ['$revenue', 0] } } }
                }
            },
            { $sort: { _id: 1 } }
        ];

        return await this.collection.aggregate(pipeline).toArray();
    }

    /**
     * Verificar se a collection existe e tem dados (READ-ONLY)
     */
    async checkHealth(): Promise<{
        exists: boolean;
        count: number;
        lastDocument?: IGamAdUnitKeyValue;
    }> {
        try {
            const count = await this.collection.estimatedDocumentCount();
            const lastDocument = await this.collection.findOne({}, { sort: { _id: -1 } });

            return {
                exists: true,
                count,
                lastDocument: lastDocument || undefined
            };
        } catch (error) {
            console.error('Error checking collection health:', error);
            return {
                exists: false,
                count: 0
            };
        }
    }
}