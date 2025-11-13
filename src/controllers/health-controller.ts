import { Request, Response } from 'express';
import { Db } from 'mongodb';
import { redis } from '../config/redis';

export class HealthController {
    private db?: Db;

    constructor(db?: Db) {
        this.db = db;
    }

    /**
     * Health check básico
     */
    public async checkHealth(_req: Request, res: Response): Promise<void> {
        res.status(200).json({
            status: 'healthy',
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Health check com verificação de dependências
     */
    public async checkHealthDetailed(_req: Request, res: Response): Promise<void> {
        const checks = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            services: {
                api: 'healthy',
                database: 'unknown',
                redis: 'unknown'
            }
        };

        let overallStatus = 200;

        // Verificar MongoDB
        if (this.db) {
            try {
                await this.db.admin().ping();
                checks.services.database = 'healthy';
            } catch (error) {
                checks.services.database = 'unhealthy';
                checks.status = 'degraded';
                overallStatus = 503;
            }
        }

        // Verificar Redis
        try {
            const pong = await redis.ping();
            checks.services.redis = pong === 'PONG' ? 'healthy' : 'unhealthy';
        } catch (error) {
            checks.services.redis = 'unhealthy';
            checks.status = 'degraded';
            overallStatus = 503;
        }

        res.status(overallStatus).json(checks);
    }

    /**
     * Readiness check para Kubernetes/Docker
     */
    public async checkReadiness(_req: Request, res: Response): Promise<void> {
        let isReady = true;

        // Verificar se MongoDB está conectado
        if (this.db) {
            try {
                await this.db.admin().ping();
            } catch (error) {
                isReady = false;
            }
        }

        // Verificar se Redis está conectado
        try {
            await redis.ping();
        } catch (error) {
            isReady = false;
        }

        if (isReady) {
            res.status(200).json({ ready: true });
        } else {
            res.status(503).json({ ready: false });
        }
    }
}