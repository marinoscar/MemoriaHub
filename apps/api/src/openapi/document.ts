// =============================================================================
// OpenAPI document construction (epic #414)
// =============================================================================
//
// Everything that shapes `/api/openapi.json` lives here rather than in
// `main.ts`, for one concrete reason: the spec is now asserted by tests and
// dumped by a CI script, and neither of those can boot a listening server. A
// pure `buildOpenApiConfig()` / `createOpenApiDocument(app)` pair can be called
// from a test harness, from `scripts/dump-openapi.ts`, and from `main.ts`
// alike, so the document CI lints is the document users get.
// =============================================================================

import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { ErrorDto } from '../common/dto/error.dto';
import { RBAC_EXTENSION_KEY } from '../auth/decorators/auth.decorator';
import { applyDataEnvelope } from './data-envelope';
import { buildApiDescription } from './description';
import { applyNullableFor31 } from './nullable';
import { applyRbacDocs } from './rbac-docs';
import { OPENAPI_TAGS, OPENAPI_TAG_GROUPS } from './tags';
import { DocOperation, MutableDocument, forEachOperation } from './types';
import { resolveApiVersion } from './version';

/** Security scheme names. `JWT_AUTH` is referenced by name from `@Auth()`. */
export const SECURITY_SCHEMES = {
  JWT_AUTH: 'JWT-auth',
  PAT_AUTH: 'PAT-auth',
  NODE_CREDENTIAL: 'Node-credential',
} as const;

/**
 * Routes a `nod_` credential is accepted on.
 *
 * Deliberately narrow, and it must stay in step with the credential guard: a
 * node credential is rejected everywhere else, so advertising it on another
 * path would document an authentication that cannot work.
 */
const NODE_CREDENTIAL_PATH = /^(?:\/api)?\/nodes(?:\/|$)/;

/**
 * The `DocumentBuilder` configuration.
 *
 * @param version resolved application version; injectable so a test can assert
 *   the shape without depending on what the build happens to be stamped with.
 */
export function buildOpenApiConfig(version: string = resolveApiVersion()) {
  const builder = new DocumentBuilder()
    .setTitle('MemoriaHub API')
    .setDescription(buildApiDescription(version))
    .setVersion(version)
    // OpenAPI 3.1, not the 3.0 default. zod v4 emits JSON Schema 2020-12, which
    // 3.1 adopts wholesale and 3.0 rejects — under 3.0 the zod-derived DTOs
    // published numeric `exclusiveMinimum` and `propertyNames` keywords that are
    // invalid there, so a schema-validating consumer (or Spectral) rightly
    // failed on them. Scalar renders 3.1 natively.
    .setOpenAPIVersion('3.1.0')
    .setContact('MemoriaHub', 'https://github.com/marinoscar/MemoriaHub', '')
    .setExternalDoc(
      'Architecture and feature specifications',
      'https://github.com/marinoscar/MemoriaHub/tree/main/docs',
    )
    // Same-origin: the UI is served at `/`, this API under `/api`, so a
    // relative server URL is correct for every deployment without templating.
    .addServer('/', 'This deployment (same-origin)')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Short-lived session access token from `POST /api/auth/refresh` or the OAuth callback. ' +
          'On this page, use "Authorize with my session" to load one automatically.',
      },
      SECURITY_SCHEMES.JWT_AUTH,
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description:
          'Personal access token (`pat_…`) from `POST /api/pat`. Long-lived, carries the full ' +
          'permission set of the user that minted it, and is accepted on every authenticated route.',
      },
      SECURITY_SCHEMES.PAT_AUTH,
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description:
          'Worker-node credential (`nod_…`) from `POST /api/node-credentials`. Accepted **only** on ' +
          '`/api/nodes/*` — it cannot reach media, settings, or admin routes even when its owner is ' +
          'an Admin.',
      },
      SECURITY_SCHEMES.NODE_CREDENTIAL,
    );

  for (const tag of OPENAPI_TAGS) {
    builder.addTag(tag.name, tag.description);
  }

  const config = builder.build();

  // `setContact` takes all three fields positionally, so an omitted email is an
  // empty string — which is not a valid `email`, and a schema-validating
  // consumer rejects the whole document over it. A contact with a name and a URL
  // is perfectly valid; fabricating an address to satisfy the field would be
  // worse than not having one.
  if (config.info.contact && !config.info.contact.email) {
    delete (config.info.contact as { email?: string }).email;
  }

  return config;
}

/**
 * Builds the finished document: Nest's introspection, then the five passes that
 * turn it into something worth reading.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig(), {
    // Namespaced but readable: `media_listMedia`, not `MediaController_listMedia`.
    // Stable across refactors that do not rename the controller or handler, which
    // is what makes generated SDK method names survive a release.
    operationIdFactory: buildOperationId,
    // ErrorDto is only ever referenced from a `$ref` this file writes, so it
    // would otherwise never be emitted into `components.schemas`.
    extraModels: [ErrorDto],
  });

  // nestjs-zod's recommended post-processing for zod-derived DTOs: resolves the
  // placeholder schemas `createZodDto` leaves behind into real JSON Schema.
  const cleaned = cleanupOpenApiDoc(document);

  // `OpenAPIObject` has no index signature, so it is not structurally a
  // `MutableDocument` even though every field the passes touch is present.
  // Widening here is the one place that conversion happens.
  enrichOpenApiDocument(cleaned as unknown as MutableDocument);

  return cleaned;
}

/**
 * The post-processing passes, split out from `createOpenApiDocument` so they can
 * be exercised against a hand-built document without booting an application.
 */
export function enrichOpenApiDocument<T extends MutableDocument>(document: T): T {
  applyRbacDocs(document);
  applyAlternativeAuthSchemes(document);
  // Order matters: the envelope pass targets 2xx JSON responses only, and the
  // error pass writes a `default` response — running the envelope first keeps
  // the two from ever meeting, but relying on that would be fragile, so the
  // envelope pass filters on the status code explicitly as well.
  applyDataEnvelope(document);
  applyDefaultErrorResponse(document);
  applyTagGroups(document);
  // Last: every earlier pass may introduce schemas of its own, and this one has
  // to see all of them.
  applyNullableFor31(document);
  return document;
}

/**
 * `AdminMemoriesController.backfill` → `adminMemories_backfill`.
 *
 * Keeps the controller as a namespace (so two `list` handlers cannot collide)
 * while dropping the noise a generator would otherwise bake into every method
 * name. Uniqueness is asserted in `openapi.spec.ts`.
 */
export function buildOperationId(controllerKey: string, methodKey: string): string {
  const namespace = controllerKey.replace(/Controller$/, '');
  const lowerFirst = namespace.charAt(0).toLowerCase() + namespace.slice(1);
  return `${lowerFirst}_${methodKey}`;
}

/**
 * Whether an operation requires a bearer token.
 *
 * Two signals, because two things put one there. `@Auth()` stamps `x-rbac`,
 * which is the richer marker. A handful of routes instead compose
 * `@UseGuards(JwtAuthGuard)` with a bare `@ApiBearerAuth('JWT-auth')` — mostly
 * on the auth controller itself, where the RBAC guards would have nothing to
 * check — and those are just as authenticated.
 */
export function isAuthenticatedOperation(operation: DocOperation): boolean {
  if (operation[RBAC_EXTENSION_KEY] !== undefined) return true;
  return (operation.security ?? []).some(
    (entry) => SECURITY_SCHEMES.JWT_AUTH in entry,
  );
}

/**
 * Adds the PAT and node-credential schemes to operations they actually work on.
 *
 * `@Auth()` can only declare the session scheme, because that is the one it
 * names. But a PAT authenticates every authenticated route, and a `nod_`
 * credential authenticates `/api/nodes/*` — both facts the docs should state.
 * Deriving them here from the path and the `x-rbac` marker keeps the claim
 * accurate as routes are added, where a hand-applied `@ApiSecurity()` would
 * quietly go stale.
 *
 * Multiple entries in an operation's `security` array are alternatives (OR), so
 * appending never tightens a requirement.
 */
function applyAlternativeAuthSchemes(document: MutableDocument): void {
  forEachOperation(document, (operation, path) => {
    if (!isAuthenticatedOperation(operation)) return;

    const security = (operation.security ??= []);
    const has = (name: string) => security.some((entry) => name in entry);

    if (!has(SECURITY_SCHEMES.PAT_AUTH)) {
      security.push({ [SECURITY_SCHEMES.PAT_AUTH]: [] });
    }
    if (NODE_CREDENTIAL_PATH.test(path) && !has(SECURITY_SCHEMES.NODE_CREDENTIAL)) {
      security.push({ [SECURITY_SCHEMES.NODE_CREDENTIAL]: [] });
    }
  });
}

/**
 * Attaches the shared error envelope as each operation's `default` response.
 *
 * A `default` rather than an enumerated 400/404/409 list per operation: every
 * error from every route passes through one `HttpExceptionFilter` and comes
 * back in one shape, so `default` states exactly that — without asserting on
 * each route's behalf which statuses it can produce, which nobody could keep
 * true across 70 controllers.
 *
 * Operations that document a specific status keep it; this only fills the gap.
 */
function applyDefaultErrorResponse(document: MutableDocument): void {
  forEachOperation(document, (operation) => {
    const responses = (operation.responses ??= {});
    if (responses.default) return;

    responses.default = {
      description:
        'Error. Every failure is rendered by the shared exception filter into this envelope; ' +
        'endpoint-specific data appears under `details`.',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/ErrorDto' } },
      },
    };
  });
}

/**
 * Emits `x-tagGroups`, the vendor extension Scalar and Redoc read to render a
 * sectioned sidebar. Renderers without support fall back to the flat `tags`
 * array, which `buildOpenApiConfig` emits in the same order.
 *
 * Tags no operation uses are pruned from both. The taxonomy is declared for the
 * whole application, but not every module is registered in every environment —
 * `Test Authentication` exists only outside production — and a declared-but-
 * unused tag renders as an empty sidebar section. Pruning is what makes one
 * static taxonomy correct in both environments.
 */
function applyTagGroups(document: MutableDocument): void {
  const used = new Set<string>();
  forEachOperation(document, (operation) => {
    for (const tag of operation.tags ?? []) used.add(tag);
  });

  document.tags = OPENAPI_TAGS.filter((tag) => used.has(tag.name));
  document['x-tagGroups'] = OPENAPI_TAG_GROUPS.map((group) => ({
    name: group.name,
    tags: group.tags.filter((tag) => used.has(tag)),
  })).filter((group) => group.tags.length > 0);
}
