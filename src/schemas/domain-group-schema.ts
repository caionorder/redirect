import type { LinkInfo } from '../utils/interleave-by-domain';

export interface IDomainGroup {
    _id?: import('mongodb').ObjectId;
    slug: string;
    name: string;
    domains: string[];
    active: boolean;
    bestRpsMode?: boolean;
    /** Path fixo (ex.: "/first-hello/"): o grupo redireciona sempre para https://<dominio><fixedPath>, rotacionando só o domínio. */
    fixedPath?: string;
    /**
     * Último ranking válido calculado pelo cron (interno: gravado só por `saveLastRanking`).
     * Rede de segurança para quando o Redis é zerado (deploy) e o GAM ainda não tem dados.
     * NUNCA exposto/aceito pela API pública — as leituras de listagem o excluem por projeção.
     */
    lastRanking?: LinkInfo[];
    lastRankingAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

export interface ICreateDomainGroup {
    slug: string;
    name: string;
    domains?: string[];
    fixedPath?: string;
}

export const domainGroupCollectionName = 'domain_groups';
