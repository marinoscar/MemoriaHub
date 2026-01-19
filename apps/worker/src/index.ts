import { workerConfig } from './config/index.js';
import { orchestrator, jobRouter } from './core/index.js';
import { createServer, startServer, stopServer } from './server.js';
import { logger, LogEventTypes } from './infrastructure/logging/index.js';

// Import and register handlers
import { thumbnailHandler } from './handlers/thumbnail.handler.js';
import { previewHandler } from './handlers/preview.handler.js';

/**
 * Register all job handlers
 */
function registerHandlers(): void {
  jobRouter.register(thumbnailHandler);
  jobRouter.register(previewHandler);

  logger.info({
    eventType: 'handlers.registered',
    handlers: jobRouter.getRegisteredTypes(),
  }, `Registered ${jobRouter.getRegisteredTypes().length} job handlers`);
}

/**
 * Handle shutdown signals
 */
function setupShutdownHandlers(server: ReturnType<typeof createServer>): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      logger.warn({ eventType: 'shutdown.duplicate', signal }, 'Shutdown already in progress');
      return;
    }

    isShuttingDown = true;
    logger.info({ eventType: 'shutdown.signal', signal }, `Received ${signal}, starting graceful shutdown`);

    try {
      // Stop accepting new connections
      await stopServer(server);

      // Stop the orchestrator (waits for jobs to complete)
      await orchestrator.stop();

      logger.info({ eventType: 'shutdown.complete' }, 'Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({
        eventType: 'shutdown.error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.fatal({
      eventType: 'uncaught_exception',
      error: error.message,
      stack: error.stack,
    }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({
      eventType: 'unhandled_rejection',
      reason: reason instanceof Error ? reason.message : String(reason),
    }, 'Unhandled rejection');
    shutdown('unhandledRejection');
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logger.info({
    eventType: LogEventTypes.WORKER_STARTED,
    workerId: workerConfig.workerId,
    nodeVersion: process.version,
    platform: process.platform,
  }, `MemoriaHub Worker starting (ID: ${workerConfig.workerId})`);

  try {
    // Register handlers
    registerHandlers();

    // Create and start HTTP server
    const server = createServer();
    await startServer(server);

    // Setup shutdown handlers
    setupShutdownHandlers(server);

    // Start the orchestrator (connects to DB/S3, starts queue pollers)
    await orchestrator.start();

    logger.info({
      eventType: LogEventTypes.WORKER_READY,
      workerId: workerConfig.workerId,
      healthEndpoint: `http://localhost:${workerConfig.server.port}/healthz`,
      metricsEndpoint: `http://localhost:${workerConfig.server.port}${workerConfig.server.metricsPath}`,
    }, `Worker ${workerConfig.workerId} is ready and processing jobs`);
  } catch (error) {
    logger.fatal({
      eventType: 'startup.error',
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }, 'Failed to start worker');
    process.exit(1);
  }
}

// Start the worker
main();
