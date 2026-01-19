import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { serverConfig } from './config/index.js';
import { loggingMiddleware } from './api/middleware/logging.middleware.js';
import { errorMiddleware, notFoundHandler } from './api/middleware/error.middleware.js';
import { createHealthRoutes } from './api/routes/health.routes.js';
import { createApiRoutes } from './api/routes/index.js';

/**
 * Create and configure Express application
 */
export function createApp(): express.Application {
  const app = express();

  // Trust proxy (for correct IP detection behind nginx)
  app.set('trust proxy', 1);

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: serverConfig.nodeEnv === 'production',
  }));

  // CORS configuration
  app.use(cors({
    origin: serverConfig.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Trace-Id'],
    exposedHeaders: ['X-Request-Id', 'X-Trace-Id'],
  }));

  // Compression
  app.use(compression());

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Request logging and context
  app.use(loggingMiddleware);

  // Health routes (before auth middleware)
  app.use(createHealthRoutes());

  // API routes
  app.use('/api', createApiRoutes());

  // 404 handler
  app.use(notFoundHandler);

  // Error handler
  app.use(errorMiddleware);

  return app;
}
