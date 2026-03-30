import { ObjectId } from "mongodb";

// Interface para o modelo de BroadClick (contador agregado por broad e data)
export interface IBroadClick {
    _id?: ObjectId;
    broad_id: string;    // the broad parameter value
    date: string;        // YYYY-MM-DD
    count: number;
    created_at: Date;
}
