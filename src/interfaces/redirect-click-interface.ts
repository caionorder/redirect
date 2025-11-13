import { ObjectId } from "mongodb";

// Interface para o modelo de RedirectClick (contador agregado)
export interface IRedirectClick {
    _id?: ObjectId;
    link_id: string;
    count: number;
    created_at: Date;
}

// Interface para criação/atualização de click
export interface ICreateRedirectClick {
    link_id: string;
}

// Interface para atualização de contador
export interface IUpdateRedirectClick {
    count?: number;
}