import { Router } from 'express';
import { RedirectController } from '../controllers/redirect-controller';

export function createRedirectRouter(controller: RedirectController): Router {
  const router = Router();

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

  // Rota para ranking de links com eCPM + click count
  router.get('/rank', (req, res) =>
    controller.getRank(req, res)
  );

  // Rota para ver ranking agrupado por domínio
  router.get('/rank-by-domain', (req, res) =>
    controller.getRankByDomain(req, res)
  );

  // Rota para valores distintos
  router.get('/distinct/:field', (req, res) =>
    controller.getDistinctValues(req, res)
  );

  // Rota para listar links de redirecionamento
  router.get('/links', (req, res) =>
    controller.getRedirectLinks(req, res)
  );

  // Rota para clicks por broad
  router.get('/broad-clicks', (req, res) =>
    controller.getBroadClicks(req, res)
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

  // Rotas para regras de in-app browser
  router.get('/inapp-rules', (req, res) =>
    controller.listInAppRules(req, res)
  );

  router.post('/inapp-rules', (req, res) =>
    controller.createInAppRule(req, res)
  );

  router.delete('/inapp-rules/:id', (req, res) =>
    controller.deleteInAppRule(req, res)
  );

  return router;
}
