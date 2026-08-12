import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { OpenAPIObject } from '@nestjs/swagger';
import { renderDocsPage } from './docs-page';
import { resolveApiVersion } from './version';

/** Canonical machine-readable document. */
export const OPENAPI_JSON_PATH = '/api/openapi.json';
/** Interactive reference. */
export const DOCS_PATH = '/api/docs';

/**
 * Registers the two documentation routes on the Fastify instance.
 *
 * Raw Fastify routes rather than `SwaggerModule.setup`, for two reasons: the
 * page is our own template (see `docs-page.ts` for why), and `setup` would
 * additionally mount the stock Swagger UI on the same path.
 *
 * Registering directly also keeps both routes outside the Nest guard pipeline —
 * matching what `SwaggerModule.setup` already did, and keeping the reference
 * readable during maintenance mode, which is exactly when an operator is most
 * likely to want it.
 *
 * Lives here rather than inline in `main.ts` so it can be exercised against a
 * test application; `main.ts` itself is excluded from coverage and cannot be
 * booted by a spec.
 */
export function registerDocsRoutes(
  app: NestFastifyApplication,
  document: OpenAPIObject,
  version: string = resolveApiVersion(),
): void {
  const page = renderDocsPage({
    title: 'MemoriaHub API Reference',
    version,
    specUrl: OPENAPI_JSON_PATH,
  });

  const fastify = app.getHttpAdapter().getInstance();

  fastify.get(OPENAPI_JSON_PATH, (_req, reply) =>
    reply.type('application/json').send(document),
  );

  // Both spellings: a reader who types the path with a trailing slash should
  // not get a 404 from the one page whose job is to orient them.
  for (const path of [DOCS_PATH, `${DOCS_PATH}/`]) {
    fastify.get(path, (_req, reply) => reply.type('text/html').send(page));
  }
}
