import { Request, Response } from 'express';
import { Db } from 'mongodb';
import { SuperFilterService } from '../services/superfilter-service';
import { GamAdUnitRepository } from '../repositories/gam-ad-unit-repository';
import { RedirectLinkRepository } from '../repositories/redirect-link-repository';
import { RedirectClickRepository } from '../repositories/redirect-click-repository';
import { IFilterRequest } from '../interfaces/filter-interfaces';

export class RedirectController {
    private db?: Db;
    private superFilterService: SuperFilterService;
    private gamAdUnitRepository?: GamAdUnitRepository;
    private redirectLinkRepository?: RedirectLinkRepository;
    private redirectClickRepository?: RedirectClickRepository;

    constructor(db?: Db) {
        this.db = db;
        this.superFilterService = new SuperFilterService();

        if (db) {
            this.gamAdUnitRepository = new GamAdUnitRepository(db);
            this.redirectLinkRepository = new RedirectLinkRepository(db);
            this.redirectClickRepository = new RedirectClickRepository(db);
        }
    }

    /**
     * Processa requisições de filtro/analytics
     * Endpoint: GET /api/process
     */
    public async process(req: Request, res: Response): Promise<void> {

        try {
            // Converter query para IFilterRequest
            const filterRequest: IFilterRequest = {
                start: req.body.start as string,
                end: req.body.end as string,
                network: req.body.network as string | undefined,
                country: req.body.country as string | undefined,
                domain: req.body.domain as string | string[] | undefined,
                ad_unit_name: req.body.ad_unit_name as string | undefined,
                custom_key: req.body.custom_key as string | undefined,
                custom_value: req.body.custom_value as string | string[] | undefined,
                group: req.body.group ? (Array.isArray(req.body.group) ? req.body.group as string[] : [req.body.group as string]) : undefined
            };


            // Verificar se o repository existe
            if (!this.gamAdUnitRepository) {
                res.status(503).json({ error: 'Database not connected' });
                return;
            }

            // Executar o filtro usando o GamAdUnitRepository
            const data = await this.superFilterService.execute(filterRequest, this.gamAdUnitRepository);
            res.status(200).json(data);
        } catch (error) {
            console.error('Error processing filter:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }

    /**
     * Processa redirecionamentos e registra clicks
     * Endpoint: GET /api/redirect
     */
    public async redirect(req: Request, res: Response): Promise<void> {
        try {
            const targetUrl = req.body.url as string;
            const linkId = req.body.id as string;

            if (!targetUrl) {
                res.status(400).json({ error: 'URL de destino é obrigatória' });
                return;
            }

            // Se tiver linkId e repositories disponíveis, registrar o click
            if (linkId && this.redirectClickRepository && this.redirectLinkRepository) {
                try {
                    // Verificar se o link existe
                    const link = await this.redirectLinkRepository.getLinkById(linkId);

                    if (link && link.status) {
                        // Incrementar contador de clicks
                        await this.redirectClickRepository.incrementClick(linkId);
                    }
                } catch (error) {
                    // Log do erro mas continua com o redirect
                    console.error('Error recording click:', error);
                }
            }

            // Fazer o redirect
            res.redirect(targetUrl);
        } catch (error) {
            console.error('Error in redirect:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: 'Failed to process redirect'
            });
        }
    }

    /**
     * Retorna estatísticas dos dados GAM
     * Endpoint: GET /api/stats
     */
    public async getStats(req: Request, res: Response): Promise<void> {
        try {
            if (!this.gamAdUnitRepository) {
                res.status(503).json({ error: 'Database not connected' });
                return;
            }

            const query = {
                start: req.query.start as string | undefined,
                end: req.query.end as string | undefined,
                domain: req.query.domain as string | string[] | undefined,
                network: req.query.network as string | undefined,
                country: req.query.country as string | undefined
            };

            const stats = await this.gamAdUnitRepository.getStats(query);
            res.status(200).json(stats);
        } catch (error) {
            console.error('Error getting stats:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: 'Failed to get statistics'
            });
        }
    }

    /**
     * Retorna valores distintos de um campo
     * Endpoint: GET /api/distinct/:field
     */
    public async getDistinctValues(req: Request, res: Response): Promise<void> {
        try {
            if (!this.gamAdUnitRepository) {
                res.status(503).json({ error: 'Database not connected' });
                return;
            }

            const field = req.params.field as any;
            const validFields = ['domain', 'network', 'country', 'custom_key', 'custom_value', 'ad_unit_name'];

            if (!validFields.includes(field)) {
                res.status(400).json({
                    error: 'Invalid field',
                    validFields
                });
                return;
            }

            const query = {
                start: req.query.start as string | undefined,
                end: req.query.end as string | undefined
            };

            const values = await this.gamAdUnitRepository.getDistinctValues(field, query);
            res.status(200).json({ field, values });
        } catch (error) {
            console.error('Error getting distinct values:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: 'Failed to get distinct values'
            });
        }
    }
}
