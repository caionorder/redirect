import { Router } from 'express';
import { RedirectController } from '../controllers/redirect-controller';
import { Db } from 'mongodb';

export function createRedirectRouter(db?: Db): Router {
  const router = Router();
  const controller = new RedirectController(db);

  // Rota de redirecionamento com tracking
  router.get('/redirect', (req, res) =>
    controller.redirect(req, res)
  );

  // Rota de processamento/analytics
  router.get('/process', (req, res) =>
    controller.process(req, res)
  );

  // Rota para estatísticas
  router.get('/stats', (req, res) =>
    controller.getStats(req, res)
  );

  // Rota para valores distintos
  router.get('/distinct/:field', (req, res) =>
    controller.getDistinctValues(req, res)
  );

  // Rota para listar links de redirecionamento
  router.get('/links', (req, res) =>
    controller.getRedirectLinks(req, res)
  );

  // Rotas para regras de redirecionamento condicional
  router.get('/rules', (req, res) =>
    controller.listRules(req, res)
  );

  router.post('/rules', (req, res) =>
    controller.createRule(req, res)
  );

  router.delete('/rules/:id', (req, res) =>
    controller.deleteRule(req, res)
  );

  return router;
}
