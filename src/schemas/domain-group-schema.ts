export interface IDomainGroup {
    _id?: import('mongodb').ObjectId;
    slug: string;
    name: string;
    domains: string[];
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface ICreateDomainGroup {
    slug: string;
    name: string;
    domains?: string[];
}

export const domainGroupCollectionName = 'domain_groups';
