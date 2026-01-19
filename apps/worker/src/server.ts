import http from 'http';
import { workerConfig } from './config/index.js';
import { orchestrator } from './core/index.js';
import { logger } from './infrastructure/logging/index.js';

/**
 * Simple HTTP server for health checks and metrics
 */
export function createServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    try {
      switch (url.pathname) {
        case '/healthz':
          handleHealthz(res);
          break;

        case '/readyz':
          await handleReadyz(res);
          break;

        case workerConfig.server.metricsPath:
          handleMetrics(res);
          break;

        case '/status':
          handleStatus(res);
          break;

        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error) {
      logger.error({
        eventType: 'server.error',
        path: url.pathname,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'Request handler error');

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  return server;
}

/**
 * Start the HTTP server
 */
export function startServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(workerConfig.server.port, () => {
      logger.info({
        eventType: 'server.started',
        port: workerConfig.server.port,
      }, `HTTP server listening on port ${workerConfig.server.port}`);
      resolve();
    });

    server.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Stop the HTTP server
 */
export function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      logger.info({ eventType: 'server.stopped' }, 'HTTP server stopped');
      resolve();
    });
  });
}

/**
 * Liveness probe - is the process alive?
 */
function handleHealthz(res: http.ServerResponse): void {
  const status = orchestrator.getStatus();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    workerId: status.workerId,
    uptime: process.uptime(),
    version: '1.0.0',
  }));
}

/**
 * Readiness probe - are all dependencies ready?
 */
async function handleReadyz(res: http.ServerResponse): Promise<void> {
  const health = await orchestrator.checkHealth();

  const statusCode = health.healthy ? 200 : 503;

  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: health.healthy ? 'ok' : 'error',
    checks: health.checks,
  }));
}

/**
 * Prometheus metrics endpoint
 * TODO: Implement proper metrics collection
 */
function handleMetrics(res: http.ServerResponse): void {
  const status = orchestrator.getStatus();

  // Basic metrics in Prometheus format
  const metrics = [
    `# HELP worker_up Worker is running`,
    `# TYPE worker_up gauge`,
    `worker_up{worker_id="${status.workerId}"} ${status.running ? 1 : 0}`,
    '',
    `# HELP worker_shutting_down Worker is shutting down`,
    `# TYPE worker_shutting_down gauge`,
    `worker_shutting_down{worker_id="${status.workerId}"} ${status.shuttingDown ? 1 : 0}`,
    '',
    `# HELP worker_active_jobs Current number of active jobs`,
    `# TYPE worker_active_jobs gauge`,
    ...status.queues.map(q =>
      `worker_active_jobs{worker_id="${status.workerId}",queue="${q.name}"} ${q.activeJobs}`
    ),
    '',
    `# HELP worker_max_concurrency Maximum job concurrency per queue`,
    `# TYPE worker_max_concurrency gauge`,
    ...status.queues.map(q =>
      `worker_max_concurrency{worker_id="${status.workerId}",queue="${q.name}"} ${q.maxConcurrency}`
    ),
    '',
  ];

  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
  res.end(metrics.join('\n'));
}

/**
 * Status endpoint - detailed worker status
 */
function handleStatus(res: http.ServerResponse): void {
  const status = orchestrator.getStatus();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status, null, 2));
}
