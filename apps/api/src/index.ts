import { createApp } from './app.js';
import { serverConfig } from './config/index.js';
import { logger, LogEventTypes } from './infrastructure/logging/logger.js';
import { closePool } from './infrastructure/database/client.js';
import { runMigrations } from './infrastructure/database/migrator.js';
import { initTracing, shutdownTracing } from './infrastructure/telemetry/tracing.js';

// Initialize tracing before anything else
initTracing();

/**
 * Bootstrap the application
 * 1. Run database migrations (creates tables if needed)
 * 2. Start HTTP server
 */
async function bootstrap(): Promise<void> {
  try {
    // Run database migrations before starting the server
    logger.info({ eventType: 'app.startup' }, 'Initializing application...');
    await runMigrations();

    const app = createApp();

    const server = app.listen(serverConfig.port, serverConfig.host, () => {
      logger.info(
        {
          eventType: LogEventTypes.SERVER_STARTED,
          port: serverConfig.port,
          host: serverConfig.host,
          nodeEnv: serverConfig.nodeEnv,
        },
        `Server started on ${serverConfig.host}:${serverConfig.port}`
      );
    });

    setupGracefulShutdown(server);
  } catch (error) {
    logger.error(
      { eventType: 'app.startup.error', error: error instanceof Error ? error.message : 'Unknown error' },
      'Failed to start application'
    );
    process.exit(1);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setupGracefulShutdown(server: any): void {
  async function shutdown(signal: string): Promise<void> {
    logger.info({ eventType: LogEventTypes.SERVER_STOPPING, signal }, `Received ${signal}, shutting down gracefully`);

    server.close(async () => {
      logger.info({ eventType: LogEventTypes.SERVER_STOPPED }, 'HTTP server closed');

      try {
        await closePool();
        await shutdownTracing();
        logger.info('Cleanup complete, exiting');
        process.exit(0);
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Error during cleanup');
        process.exit(1);
      }
    });

    // Force exit after 30 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
  logger.error({ error: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled rejection');
});

// Start the application
bootstrap();
