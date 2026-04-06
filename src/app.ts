import express, { Express } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import morgan from 'morgan';
import { connectDB } from './config/database';
import { redis } from './config/redis';
//import { limiter } from './config/rate-limit';
import { createHealthRouter } from './routes/health-route';
import { createRedirectRouter } from './routes/redirect-route';
import { RedirectController } from './controllers/redirect-controller';
import { errorHandler } from './middleware/error-handler';
import { Db } from 'mongodb';
import { domains, domains_db } from './config/domains';
import { DomainGroupService } from './services/domain-group-service';
import { createDomainGroupRouter } from './routes/domain-group-route';

export async function createApp(): Promise<Express> {
    const app = express();

    // Gerar frame-src dinamicamente a partir dos domínios configurados (fallback estatico)
    const allDomains = [...domains, ...domains_db];
    const frameSrcDomains = allDomains.flatMap(d => [`https://${d}`, `https://*.${d}`]);

    // Configurações de segurança
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                frameSrc: ["'self'", ...frameSrcDomains],
                frameAncestors: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
            }
        }
    }));
    app.set('trust proxy', 1);
    app.disable('x-powered-by');
    app.set('etag', false);

    // Logging - formato simplificado
    if (process.env.NODE_ENV !== 'test') {
        app.use(morgan('[UTM REQUEST] :method :url'));
    }

    // Compressão
    app.use(compression({
        level: 6,
        threshold: 1024 // Comprimir apenas respostas > 1KB
    }));

    // CORS
    app.use(cors({
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true
    }));

    // Body parsing
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Rate limiting
    //app.use('/api/', limiter);

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

    // Rotas de health check (sempre disponíveis)
    app.use(createHealthRouter(db));

    // Rotas principais da aplicação
    if (db) {
        // Inicializar o DomainGroupService (singleton) e fazer seed se necessario
        const domainGroupService = DomainGroupService.getInstance(db);
        await domainGroupService.seed();

        // Atualizar CSP com dominios do banco apos seed
        try {
            const dynamicDomains = await domainGroupService.getAllDomains();
            const dynamicFrameSrc = dynamicDomains.flatMap(d => [`https://${d}`, `https://*.${d}`]);
            // Re-aplicar helmet com dominios atualizados (o ultimo middleware vence)
            app.use(helmet({
                contentSecurityPolicy: {
                    directives: {
                        defaultSrc: ["'self'"],
                        frameSrc: ["'self'", ...frameSrcDomains, ...dynamicFrameSrc],
                        frameAncestors: ["'self'"],
                        scriptSrc: ["'self'", "'unsafe-inline'"],
                        styleSrc: ["'self'", "'unsafe-inline'"],
                    }
                }
            }));
        } catch (error) {
            console.error('[CSP] Error loading dynamic domains for CSP:', error);
        }

        // Criar o controller de redirect uma vez
        const redirectController = new RedirectController(db);

        // IMPORTANTE: Rota raiz "/" executa o redirect diretamente (grupo "main")
        app.get('/', (req, res) => redirectController.redirect(req, res));

        // Rota "/db" executa o redirect usando grupo "db"
        app.get('/db', (req, res) => redirectController.redirectByGroup(req, res, 'db'));

        // Montar as rotas em /api (antes das rotas com :campaignId para não conflitar)
        app.use('/api', createRedirectRouter(db));

        // Montar rotas de CRUD de domain groups
        app.use('/api/domain-groups', createDomainGroupRouter(domainGroupService));

        // Registrar rotas dinamicas para grupos alem de "main" e "db"
        try {
            const slugs = await domainGroupService.getActiveSlugs();
            for (const slug of slugs) {
                if (slug === 'main' || slug === 'db') continue;
                console.log(`[ROUTES] Registering dynamic route /${slug}`);
                app.get(`/${slug}`, (req, res) => redirectController.redirectByGroup(req, res, slug));
                app.get(`/${slug}/:campaignId`, (req, res) => redirectController.redirectByGroup(req, res, slug));
            }
        } catch (error) {
            console.error('[ROUTES] Error registering dynamic routes:', error);
        }

        // Rotas com campaignId no path (ex: /120242094780560734 ou /db/120242094780560734)
        app.get('/db/:campaignId', (req, res) => redirectController.redirectByGroup(req, res, 'db'));
        app.get('/:campaignId', (req, res) => redirectController.redirect(req, res));
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
