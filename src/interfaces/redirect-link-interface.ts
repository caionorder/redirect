import { ObjectId } from "mongodb";

// Interface para o modelo de RedirectLink
export interface IRedirectLink {
    _id?: ObjectId;
    domain: string;
    url: string;
    status: boolean;
    created_at: Date;
    updated_at: Date;
}

// Interface para criação de um novo link
export interface ICreateRedirectLink {
    domain: string;
    url: string;
    status: boolean;
}

// Interface para atualização de um link
export interface IUpdateRedirectLink {
    domain?: string;
    url?: string;
    status?: boolean;
}
