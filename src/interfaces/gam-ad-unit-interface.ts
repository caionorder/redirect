import { ObjectId } from 'mongodb';

/**
 * Interface para o modelo de dados GAM Ad Unit Key Values (READ-ONLY)
 * Collection: gam_ad_unit_key_values
 * IMPORTANTE: Esta é uma collection somente leitura
 */
export interface IGamAdUnitKeyValue {
    _id?: ObjectId;
    date: string;
    domain?: string;
    domain_id?: string;
    network?: string;
    country?: string;
    ad_unit_name?: string;
    custom_key?: string;
    custom_value?: string;
    impressions?: number | string;
    clicks?: number | string;
    revenue?: number | string;
    revenue_client?: number | string;
    ecpm?: number | string;
    ctr?: number | string;
    active_view?: number | string;
    unfilled_impressions?: number | string;
    requests_served?: number | string;
    elegible_ad_request?: number | string;
    pmr?: number | string;
    revshare?: number;
    hour?: string;
    brand_name?: string;
    advertiser_name?: string;
    created_at?: Date;
    updated_at?: Date;
}

/**
 * Interface para query de busca (READ-ONLY)
 */
export interface IGamAdUnitQuery {
    start?: string;
    end?: string;
    domain?: string | string[];
    network?: string;
    country?: string;
    ad_unit_name?: string;
    custom_key?: string;
    custom_value?: string | string[];
}