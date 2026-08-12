// IMPORTANT: Load instrumentation before anything else
import './instrumentation';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import fastifyCookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { fastifyAdapterOptions } from './common/fastify-setup';
import { createOpenApiDocument } from './openapi/document';
import {
  DOCS_PATH,
  OPENAPI_JSON_PATH,
  registerDocsRoutes,
} from './openapi/register-docs-routes';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Safety check: prevent test auth module in production
  if (process.env.NODE_ENV === 'production' && process.env.TEST_AUTH_ENABLED === 'true') {
    throw new Error('TEST_AUTH_ENABLED must not be true in production');
  }

  // Options live in common/fastify-setup.ts so the integration harness boots
  // the SAME server — see that file's header for the 414 bug the split hid.
  const adapter = new FastifyAdapter(fastifyAdapterOptions({ logger: true }));

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // SECURITY: do not add `http2: true` here without reading
    // docs/security/dependency-exceptions.md first. The pinned `find-my-way`
    // dependency (via @nestjs/platform-fastify) carries an accepted,
    // documented HTTP/2 DDoS advisory (GHSA-c96f-x56v-gq3h) that is only
    // inert because HTTP/2 is off. Enabling HTTP/2 reactivates it.
    adapter,
  );

  // Register cookie plugin
  await app.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET,
  });

  // Register multipart plugin for file uploads
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB for simple upload
      files: 1,
    },
  });

  // Global prefix for all routes
  app.setGlobalPrefix('api');

  // Enable CORS (same-origin by default, configurable)
  app.enableCors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  });

  // OpenAPI: the spec at /api/openapi.json, the Scalar reference at /api/docs.
  // See openapi/register-docs-routes.ts for why these are raw Fastify routes.
  registerDocsRoutes(app, createOpenApiDocument(app));

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`Application running on port ${port}`);
  logger.log(`API reference available at ${DOCS_PATH} (spec: ${OPENAPI_JSON_PATH})`);
}

bootstrap();
