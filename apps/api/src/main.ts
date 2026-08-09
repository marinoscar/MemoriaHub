// IMPORTANT: Load instrumentation before anything else
import './instrumentation';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from '@nestjs/common';
import fastifyCookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Safety check: prevent test auth module in production
  if (process.env.NODE_ENV === 'production' && process.env.TEST_AUTH_ENABLED === 'true') {
    throw new Error('TEST_AUTH_ENABLED must not be true in production');
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // SECURITY: do not add `http2: true` here without reading
    // docs/security/dependency-exceptions.md first. The pinned `find-my-way`
    // dependency (via @nestjs/platform-fastify) carries an accepted,
    // documented HTTP/2 DDoS advisory (GHSA-c96f-x56v-gq3h) that is only
    // inert because HTTP/2 is off. Enabling HTTP/2 reactivates it.
    new FastifyAdapter({ logger: true }),
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

  // RFC 8058 one-click unsubscribe (epic #300, issue #311) POSTs
  // `List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded`.
  // Fastify ships parsers for JSON and text/plain only, so without this an
  // unsubscribe triggered from a mail client's own button would be rejected
  // with 415 before ever reaching the route. The body is intentionally left as
  // the raw string: the only route accepting this content type ignores it
  // entirely (the capability is the signed token in the URL, never the body),
  // and parsing it would be a needless attack surface. @fastify/formbody is not
  // pulled in for the same reason — a dependency for a body nobody reads.
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req: unknown, body: string, done: (err: Error | null, body?: unknown) => void) =>
        done(null, body),
    );

  // Global prefix for all routes
  app.setGlobalPrefix('api');

  // Enable CORS (same-origin by default, configurable)
  app.enableCors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  });

  // Swagger/OpenAPI setup
  const config = new DocumentBuilder()
    .setTitle('Enterprise App API')
    .setDescription('API documentation for the Enterprise App Foundation')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter JWT token',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/openapi.json',
  });

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`Application running on port ${port}`);
  logger.log(`Swagger UI available at /api/docs`);
}

bootstrap();
