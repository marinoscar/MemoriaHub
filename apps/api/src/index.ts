import { createApp } from './app.js';
import { serverConfig } from './config/index.js';
import { logger, LogEventTypes } from './infrastructure/logging/logger.js';
import { closePool } from './infrastructure/database/client.js';
import { initTracing, shutdownTracing } from './infrastructure/telemetry/tracing.js';

// Initialize tracing before anything else
initTracing();

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

// Graceful shutdown
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

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
  logger.error({ error: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled rejection');
});
