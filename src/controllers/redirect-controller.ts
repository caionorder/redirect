import { Request, Response } from 'express';
import { Db } from 'mongodb';
import { redis } from '../config/redis';
import { SuperFilterService } from '../services/superfilter-service';

export class RedirectController {
     private db?: Db;
     private superFilterService: SuperFilterService;

    constructor(db?: Db) {
        this.db = db;
        this.superFilterService = new SuperFilterService();
    }

    public async process(req: Request, res: Response): Promise<void> {
        // Lógica para processar a requisição
        const data = this.superFilterService.execute(req.query, this.db);
        res.status(200).json(data);
    }

    public async redirect(req: Request, res: Response): Promise<void> {
        const targetUrl = req.query.url as string;

        if (!targetUrl) {
            res.status(400).json({ error: 'URL de destino é obrigatória' });
            return;
        }

        // Lógica para registrar o redirecionamento no banco de dados, se necessário

        res.redirect(targetUrl);
    }

}
