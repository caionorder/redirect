import cluster, { Worker } from 'cluster';
import os from 'os';

export interface SetupCallback {
    (): void;
}

export interface WorkerExitListener {
    (worker: Worker, code: number | null, signal: NodeJS.Signals | null): void;
}

export function setupCluster(callback: SetupCallback): void {
    // Determinar número de workers baseado no ambiente
    const isDev = process.env.NODE_ENV === 'development';
    const clusterEnabled = process.env.CLUSTER_ENABLED !== 'false';

    // Em desenvolvimento ou se clustering estiver desabilitado, roda sem cluster
    if (!clusterEnabled || isDev) {
        console.log('🚀 Running in single process mode');
        callback();
        return;
    }

    if (cluster.isPrimary) {
        const workerCount = process.env.WORKER_COUNT
            ? parseInt(process.env.WORKER_COUNT, 10)
            : os.cpus().length;

        console.log(`🚀 Starting ${workerCount} workers...`);

        for (let i = 0; i < workerCount; i++) {
            cluster.fork();
        }

        cluster.on('exit', (worker: Worker, code: number | null, signal: NodeJS.Signals | null) => {
            console.log(`Worker ${worker.process.pid} died`);
            console.log('Starting a new worker...');
            cluster.fork();
        });
    } else {
        callback();
    }
}
