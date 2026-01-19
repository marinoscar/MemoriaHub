import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
      },
    },
  }),
});

logger.info('Worker service starting...');
logger.info('Worker service is a placeholder - implementation coming soon');

// Keep the process alive
setInterval(() => {
  logger.debug('Worker heartbeat');
}, 60000);
