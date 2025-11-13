import { Db } from 'mongodb';

/**
 * Interface para parâmetros de requisição do filtro
 */
export interface IFilterRequest {
    start: string;
    end: string;
    network?: string;
    country?: string;
    domain?: string | string[];
    ad_unit_name?: string;
    custom_key?: string;
    custom_value?: string | string[];
    group?: string[];
}

/**
 * Interface para parâmetros preparados do filtro
 */
export interface IFilterParams {
    start: string | null;
    end: string | null;
    network: string | null;
    country: string | null;
    domain?: string | string[];
    ad_unit_name: string | null;
    custom_key: string | null;
    custom_value: string | string[] | null;
    group: string[] | null;
}

/**
 * Interface para item de dados bruto
 */
export interface IDataItem {
    ad_unit_name?: string;
    domain?: string;
    domain_id?: string;
    network?: string;
    revshare?: number;
    hour?: string;
    impressions?: number | string;
    clicks?: number | string;
    revenue?: number | string;
    revenue_client?: number | string;
    ecpm?: number | string;
    active_view?: number | string;
    unfilled_impressions?: number | string;
    requests_served?: number | string;
    elegible_ad_request?: number | string;
    pmr?: number | string;
    custom_key?: string;
    custom_value?: string;
    date?: string;
    country?: string;
    brand_name?: string;
    advertiser_name?: string;
    ctr?: number;
    ecpm_client?: number;
}

/**
 * Interface para item de dados processado
 */
export interface IProcessedData {
    ad_unit_name?: string;
    domain?: string;
    domain_id?: string;
    network?: string;
    revshare?: number;
    hour?: string;
    impressions: number;
    clicks: number;
    revenue: number;
    revenue_client: number;
    ecpm: number;
    ecpm_client?: number;
    ctr?: number;
    active_view: number;
    unfilled_impressions: number | null;
    requests_served: number;
    elegible_ad_request: number;
    pmr: number;
    custom_key?: string;
    custom_value?: string;
    date?: string;
    country?: string;
    brand_name?: string;
    advertiser_name?: string;
}

/**
 * Interface para resposta de erro
 */
export interface IErrorResponse {
    status: string;
    data: any[];
    message: string;
}

/**
 * Interface para estágio de match do MongoDB
 */
export interface IMatchStage {
    date: {
        $gte: string;
        $lte: string;
    };
    domain?: { $in: string[] };
    network?: string;
    country?: string;
    custom_key?: string;
    custom_value?: { $in: string[] };
    ad_unit_name?: {
        $regex: string;
        $options: string;
    };
}

/**
 * Interface para estágio de grupo do MongoDB
 */
export interface IGroupStage {
    $group: {
        _id: Record<string, string>;
        impressions: { $sum: string };
        clicks: { $sum: string };
        revenue: { $sum: string };
        revenue_client: { $sum: string };
        unfilled_impressions: { $sum: string };
        requests_served: { $sum: string };
        elegible_ad_request: { $sum: string };
        ecpm: { $avg: string };
        active_view: { $avg: string };
        pmr: { $avg: string };
        revshare: { $avg: string };
    };
}

/**
 * Interface para repositório MongoDB customizado
 */
export interface IRepository {
    query(): any; // Retorna uma collection do MongoDB
}