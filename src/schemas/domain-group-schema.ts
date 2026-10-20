export interface IDomainGroup {
    _id?: import('mongodb').ObjectId;
    slug: string;
    name: string;
    domains: string[];
    active: boolean;
    bestRpsMode?: boolean;
    /** Path fixo (ex.: "/first-hello/"): o grupo redireciona sempre para https://<dominio><fixedPath>, rotacionando só o domínio. */
    fixedPath?: string;
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
