import { Request, Response } from 'express';
import { DomainGroupService } from '../services/domain-group-service';

export class DomainGroupController {
    private service: DomainGroupService;

    constructor(service: DomainGroupService) {
        this.service = service;
    }

    /**
     * GET /api/domain-groups — listar todos os grupos
     */
    async list(_req: Request, res: Response): Promise<void> {
        try {
            const groups = await this.service.getAllGroups();
            res.status(200).json({ groups });
        } catch (error) {
            console.error('Error listing domain groups:', error);
            res.status(500).json({ error: 'Failed to list domain groups' });
        }
    }

    /**
     * POST /api/domain-groups — criar grupo
     * Body: { slug: string, name: string, domains?: string[] }
     */
    async create(req: Request, res: Response): Promise<void> {
        try {
            const { slug, name, domains } = req.body;

            if (!slug || !name) {
                res.status(400).json({ error: 'slug and name are required' });
                return;
            }

            // Validar slug: apenas letras minusculas, numeros, hifens
            if (!/^[a-z0-9-]+$/.test(slug)) {
                res.status(400).json({ error: 'slug must contain only lowercase letters, numbers, and hyphens' });
                return;
            }

            const group = await this.service.createGroup({ slug, name, domains });
            res.status(201).json({ group });
        } catch (error) {
            // Duplicate key error
            if (error instanceof Error && error.message.includes('E11000')) {
                res.status(409).json({ error: `Group with slug already exists` });
                return;
            }
            console.error('Error creating domain group:', error);
            res.status(500).json({ error: 'Failed to create domain group' });
        }
    }

    /**
     * PUT /api/domain-groups/:slug — editar slug e/ou name
     * Body: { slug?: string, name?: string }
     */
    async update(req: Request, res: Response): Promise<void> {
        try {
            const currentSlug = req.params.slug as string;
            const { slug: newSlug, name, bestRpsMode } = req.body;

            if (!newSlug && !name && typeof bestRpsMode !== 'boolean') {
                res.status(400).json({ error: 'At least one of slug, name, or bestRpsMode is required' });
                return;
            }

            if (newSlug && !/^[a-z0-9-]+$/.test(newSlug)) {
                res.status(400).json({ error: 'slug must contain only lowercase letters, numbers, and hyphens' });
                return;
            }

            const group = await this.service.updateGroup(currentSlug, { slug: newSlug, name, bestRpsMode });
            if (!group) {
                res.status(404).json({ error: 'Group not found' });
                return;
            }

            res.status(200).json({ group });
        } catch (error) {
            if (error instanceof Error && error.message.includes('E11000')) {
                res.status(409).json({ error: 'A group with that slug already exists' });
                return;
            }
            console.error('Error updating domain group:', error);
            res.status(500).json({ error: 'Failed to update domain group' });
        }
    }

    /**
     * DELETE /api/domain-groups/:slug — deletar grupo
     */
    async delete(req: Request, res: Response): Promise<void> {
        try {
            const { slug } = req.params;

            if (slug === 'main') {
                res.status(403).json({ error: 'Cannot delete the main group' });
                return;
            }

            const deleted = await this.service.deleteGroup(slug as string);
            if (!deleted) {
                res.status(404).json({ error: 'Group not found' });
                return;
            }

            res.status(200).json({ message: `Group '${slug}' deleted` });
        } catch (error) {
            console.error('Error deleting domain group:', error);
            res.status(500).json({ error: 'Failed to delete domain group' });
        }
    }

    /**
     * POST /api/domain-groups/:slug/domains — adicionar dominios
     * Body: { domains: string[] }
     */
    async addDomains(req: Request, res: Response): Promise<void> {
        try {
            const { slug } = req.params;
            const { domains } = req.body;

            if (!Array.isArray(domains) || domains.length === 0) {
                res.status(400).json({ error: 'domains must be a non-empty array of strings' });
                return;
            }

            const group = await this.service.addDomains(slug as string, domains);
            if (!group) {
                res.status(404).json({ error: 'Group not found' });
                return;
            }

            res.status(200).json({ group });
        } catch (error) {
            console.error('Error adding domains:', error);
            res.status(500).json({ error: 'Failed to add domains' });
        }
    }

    /**
     * DELETE /api/domain-groups/:slug/domains — remover dominios
     * Body: { domains: string[] }
     */
    async removeDomains(req: Request, res: Response): Promise<void> {
        try {
            const { slug } = req.params;
            const { domains } = req.body;

            if (!Array.isArray(domains) || domains.length === 0) {
                res.status(400).json({ error: 'domains must be a non-empty array of strings' });
                return;
            }

            const group = await this.service.removeDomains(slug as string, domains);
            if (!group) {
                res.status(404).json({ error: 'Group not found' });
                return;
            }

            res.status(200).json({ group });
        } catch (error) {
            console.error('Error removing domains:', error);
            res.status(500).json({ error: 'Failed to remove domains' });
        }
    }
}
