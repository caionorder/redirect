import { Router } from 'express';
import { HealthController } from '../controllers/health-controller';
import { Db } from 'mongodb';

export function createHealthRouter(db?: Db): Router {
    const router = Router();
    const healthController = new HealthController(db);

    // Health check básico
    router.get('/health', (req, res) =>
        healthController.checkHealth(req, res)
    );

    // Health check detalhado
    router.get('/health/detailed', (req, res) =>
        healthController.checkHealthDetailed(req, res)
    );

    // Readiness probe
    router.get('/health/ready', (req, res) =>
        healthController.checkReadiness(req, res)
    );

    // Ping simples
    router.get('/ping', (req, res) => {
        res.status(200).send('pong');
    });

    return router;
}