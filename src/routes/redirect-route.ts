import { Router } from 'express';
import { RedirectController } from '../controllers/redirect-controller';
import { Db } from 'mongodb';

export function createRedirectRouter(db?: Db): Router {
  const router = Router();
  const controller = new RedirectController(db);

  router.get('/redirect', (req, res) =>
    controller.redirect(req, res)
  );

  router.get('/process', (req, res) =>
    controller.process(req, res)
  );

  return router;
}
