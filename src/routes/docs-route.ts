import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import swaggerUi from 'swagger-ui-express';

const SPEC_PATH = path.resolve(__dirname, '../../docs/openapi.yaml');

let cachedSpec: unknown | null = null;

function loadSpec(): unknown {
    if (cachedSpec) return cachedSpec;
    const raw = fs.readFileSync(SPEC_PATH, 'utf-8');
    cachedSpec = yaml.load(raw);
    return cachedSpec;
}

const REDOC_HTML = `<!DOCTYPE html>
<html>
<head>
    <title>Redirect API - Docs</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
    <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
    <redoc spec-url='/openapi.json'></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>`;

export function createDocsRouter(): Router {
    const router = Router();

    router.get('/openapi.json', (_req: Request, res: Response) => {
        try {
            const spec = loadSpec();
            res.status(200).json(spec);
        } catch (error) {
            console.error('[DOCS] Failed to load OpenAPI spec:', error);
            res.status(500).json({ error: 'Failed to load OpenAPI spec' });
        }
    });

    router.get('/redocs', (_req: Request, res: Response) => {
        res.status(200).type('html').send(REDOC_HTML);
    });

    const spec = loadSpec();
    router.use('/api-docs', swaggerUi.serveFiles(spec as Record<string, unknown>), swaggerUi.setup(spec as Record<string, unknown>));

    return router;
}
