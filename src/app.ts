import express, { Express, Router } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import morgan from 'morgan';
import { connectDB } from './config/database';
import { redis } from './config/redis';
//import { limiter } from './config/rate-limit';
import { createHealthRouter } from './routes/health-route';
import { createDocsRouter } from './routes/docs-route';
import { createRedirectRouter } from './routes/redirect-route';
import { RedirectController } from './controllers/redirect-controller';
import { errorHandler } from './middleware/error-handler';
import { Db } from 'mongodb';
import { DomainGroupService } from './services/domain-group-service';
import { createDomainGroupRouter } from './routes/domain-group-route';

export async function createApp(): Promise<Express> {
    const app = express();

    app.set('trust proxy', 1);
    app.disable('x-powered-by');
    app.set('etag', false);

    // Conectar ao MongoDB
    let db: Db | undefined;

    if (process.env.MONGODB_URL) {
        try {
            db = await connectDB(process.env.MONGODB_URL);
            console.log('✅ MongoDB connected successfully');
        } catch (error) {
            console.error('❌ MongoDB connection failed:', error);
            // Continua rodando sem MongoDB se falhar
        }
    } else {
        console.warn('⚠️ MONGODB_URL not configured');
    }

    // Verificar conexão com Redis
    try {
        await redis.ping();
        console.log('✅ Redis connected successfully');
    } catch (error) {
        console.error('❌ Redis connection failed:', error);
        // Continua rodando sem Redis se falhar
    }

    // Rotas de health check (sempre disponíveis, sem middlewares pesados)
    app.use(createHealthRouter(db));

    // Rotas de documentação OpenAPI (Redoc + Swagger UI)
    // Sempre disponíveis, independente de DB:
    //   GET /openapi.json - spec OpenAPI 3.0
    //   GET /redocs       - UI Redoc
    //   GET /api-docs     - UI Swagger
    app.use(createDocsRouter());

    // Rotas principais da aplicação
    if (db) {
        // Inicializar o DomainGroupService (singleton) e fazer seed se necessario
        const domainGroupService = DomainGroupService.getInstance(db);
        await domainGroupService.seed();

        // Criar o controller de redirect uma vez (singleton) — injetado em todas as rotas
        const redirectController = new RedirectController(db);

        // Router /api com middlewares pesados (helmet, cors, compression, json, urlencoded, morgan).
        // Hot path de redirect (/, /:slug, /db) NÃO passa por estes middlewares.
        const apiRouter = Router();

        apiRouter.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    frameSrc: ["'self'", "*"],
                    frameAncestors: ["'self'"],
                    scriptSrc: ["'self'", "'unsafe-inline'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                }
            }
        }));

        apiRouter.use(compression({
            level: 6,
            threshold: 1024 // Comprimir apenas respostas > 1KB
        }));

        apiRouter.use(cors({
            origin: process.env.CORS_ORIGIN || '*',
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            credentials: true
        }));

        apiRouter.use(express.json({ limit: '10mb' }));
        apiRouter.use(express.urlencoded({ extended: true, limit: '10mb' }));

        if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'production') {
            apiRouter.use(morgan('[UTM REQUEST] :method :url'));
        }

        // Montar sub-routers em /api
        apiRouter.use('/domain-groups', createDomainGroupRouter(domainGroupService));
        apiRouter.use('/', createRedirectRouter(redirectController));

        app.use('/api', apiRouter);

        // IMPORTANTE: Rota raiz "/" executa o redirect diretamente (grupo "main")
        app.get('/', (req, res) => redirectController.redirect(req, res));

        // Rota "/db" executa o redirect usando grupo "db"
        app.get('/db', (req, res) => redirectController.redirectByGroup(req, res, 'db'));

        // Rotas estáticas para /db com campaignId
        app.get('/db/:campaignId', (req, res) => redirectController.redirectByGroup(req, res, 'db'));

        // Catch-all: captura slugs (criados em qualquer momento) + fallback pra grupo main
        app.get('/:param', (req, res) => {
            const param = req.params.param;
            const slugs = domainGroupService.getActiveSlugsSync();
            if (slugs.includes(param) && param !== 'main') {
                redirectController.redirectByGroup(req, res, param);
            } else {
                redirectController.redirect(req, res);
            }
        });

        app.get('/:param/:campaignId', (req, res) => {
            const param = req.params.param;
            const slugs = domainGroupService.getActiveSlugsSync();
            if (slugs.includes(param) && param !== 'main') {
                redirectController.redirectByGroup(req, res, param);
            } else {
                redirectController.redirect(req, res);
            }
        });
    } else {
        // Rota de fallback se não houver DB
        app.use('/api', (_req, res) => {
            res.status(503).json({
                error: 'Service temporarily unavailable - Database not connected'
            });
        });

        // Fallback para raiz também
        app.get('/', (_req, res) => {
            res.status(503).json({
                error: 'Service temporarily unavailable - Database not connected'
            });
        });
    }

    // Rota 404 para endpoints não encontrados
    app.use('*', (req, res) => {
        res.status(404).json({
            error: 'Not Found',
            message: `Cannot ${req.method} ${req.originalUrl}`,
            timestamp: new Date().toISOString()
        });
    });

    // Error handler global (deve ser o último middleware)
    app.use(errorHandler);

    return app;
}
