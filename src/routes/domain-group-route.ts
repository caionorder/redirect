import { Router } from 'express';
import { DomainGroupController } from '../controllers/domain-group-controller';
import { DomainGroupService } from '../services/domain-group-service';

export function createDomainGroupRouter(service: DomainGroupService): Router {
    const router = Router();
    const controller = new DomainGroupController(service);

    // Listar todos os grupos
    router.get('/', (req, res) => controller.list(req, res));

    // Criar grupo
    router.post('/', (req, res) => controller.create(req, res));

    // Editar grupo (slug e/ou name)
    router.put('/:slug', (req, res) => controller.update(req, res));

    // Deletar grupo
    router.delete('/:slug', (req, res) => controller.delete(req, res));

    // Adicionar dominios a um grupo
    router.post('/:slug/domains', (req, res) => controller.addDomains(req, res));

    // Remover dominios de um grupo
    router.delete('/:slug/domains', (req, res) => controller.removeDomains(req, res));

    return router;
}
