// =============================================================================
// OpenAPI document (RETRO-B1, #597)
// =============================================================================
//
// The document is built by the platform host slice (`createOpenApiDocument`:
// DocumentBuilder, nestjs-zod cleanup, the RBAC "Requires" line, the `{ data }`
// envelope, the default error response, the OpenAPI 3.1 nullable rewrite) and
// served by `registerPlatformDocs`-style routes at `/api/docs` and
// `/api/openapi.json` (`main.ts`). What stays here is what the platform has no
// option for:
//
//   * the Node-credential security scheme (`nod_`, accepted only on
//     `/api/nodes/*`) and its per-path alternative-auth entries;
//   * the tag taxonomy and `x-tagGroups` sidebar (`./tags`). The platform tag
//     registry rejects ':' in a tag name, and renaming the `Admin: X` tags would
//     change every client generated from the document, so the taxonomy is applied
//     as a pass over the finished document (PLATFORM-ADOPTION-SHIM(#597));
//   * the per-circle role clause of the "Requires" line (`@Auth({ circleRole })`),
//     which the platform's RBAC pass does not know about.
//
// `scripts/dump-openapi.ts` and `main.ts` both call `createAppOpenApiDocument`,
// so the document CI lints is the one users get.
// =============================================================================

import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  REQUIREMENTS_MARKER,
  SECURITY_SCHEMES as PLATFORM_SECURITY_SCHEMES,
  createOpenApiDocument,
  forEachOperation,
} from '@marinoscar/platform-api/host';
import type { MutableDocument, PlatformOpenApiOptions } from '@marinoscar/platform-api/host';
import { RBAC_EXTENSION_KEY } from '../auth/decorators/auth.decorator';
import type { RbacExtension } from '../auth/decorators/auth.decorator';
import { buildApiDescription } from './description';
import { OPENAPI_TAGS, OPENAPI_TAG_GROUPS } from './tags';
import { resolveApiVersion } from './version';

export const SECURITY_SCHEMES = {
  ...PLATFORM_SECURITY_SCHEMES,
  NODE_CREDENTIAL: 'Node-credential',
} as const;

export const APP_NAME = 'MemoriaHub';
export const REPO_URL = 'https://github.com/marinoscar/MemoriaHub';

/** What the platform needs to build the document: identity and version. */
export const APP_OPENAPI: PlatformOpenApiOptions = {
  appName: APP_NAME,
  repoUrl: REPO_URL,
  version: resolveApiVersion,
  description: (version: string) => buildApiDescription(version),
};

const NODE_CREDENTIAL_PATH = /^(?:\/api)?\/nodes(?:\/|$)/;

/**
 * The finished OpenAPI document: the platform's, plus the app passes above.
 */
export function createAppOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = createOpenApiDocument(app, APP_OPENAPI);
  return enrichAppDocument(document);
}

/** Applies the app passes in place (exported for tests). */
export function enrichAppDocument(document: OpenAPIObject): OpenAPIObject {
  const mutable = document as unknown as MutableDocument;
  applyNodeCredentialScheme(document, mutable);
  applyCircleRoleRequirements(mutable);
  applyAppTags(mutable);
  return document;
}

function applyNodeCredentialScheme(document: OpenAPIObject, mutable: MutableDocument): void {
  document.components ??= {};
  document.components.securitySchemes ??= {};
  document.components.securitySchemes[SECURITY_SCHEMES.NODE_CREDENTIAL] = {
    type: 'http',
    scheme: 'bearer',
    description:
      'Worker-node credential (`nod_…`) from `POST /api/node-credentials`. Accepted **only** on ' +
      '`/api/nodes/*` — it cannot reach media, settings, or admin routes even when its owner is ' +
      'an Admin.',
  };

  forEachOperation(mutable, (operation, path) => {
    const authenticated =
      operation[RBAC_EXTENSION_KEY] !== undefined ||
      (operation.security ?? []).some((entry) => SECURITY_SCHEMES.JWT_AUTH in entry);
    if (!authenticated || !NODE_CREDENTIAL_PATH.test(path)) return;
    const security = (operation.security ??= []);
    if (!security.some((entry) => SECURITY_SCHEMES.NODE_CREDENTIAL in entry)) {
      security.push({ [SECURITY_SCHEMES.NODE_CREDENTIAL]: [] });
    }
  });
}

/**
 * The platform's "Requires" sentence names roles and permissions; an operation
 * that also declares a per-circle role gets the app's fuller sentence instead
 * (`..., plus permission \`x\` and per-circle role \`y\` or higher.`), exactly
 * as the document read before the platform took the RBAC pass over.
 */
function applyCircleRoleRequirements(document: MutableDocument): void {
  forEachOperation(document, (operation) => {
    const rbac = operation[RBAC_EXTENSION_KEY] as RbacExtension | undefined;
    if (!rbac?.circleRole || typeof operation.description !== 'string') return;
    const at = operation.description.indexOf(REQUIREMENTS_MARKER);
    if (at < 0) return;
    operation.description = `${operation.description.slice(0, at)}${describeRequirements(rbac)}`;
  });
}

function describeRequirements(rbac: RbacExtension): string {
  const code = (value: string) => `\`${value}\``;
  const clauses: string[] = [];
  const roles = rbac.roles ?? [];
  const permissions = rbac.permissions ?? [];

  if (roles.length === 1) clauses.push(`system role ${code(roles[0])}`);
  else if (roles.length > 1) clauses.push(`any of the system roles ${roles.map(code).join(', ')}`);

  if (permissions.length === 1) clauses.push(`permission ${code(permissions[0])}`);
  else if (permissions.length > 1) {
    clauses.push(`permissions ${permissions.map(code).join(' and ')}`);
  }

  if (rbac.circleRole) clauses.push(`per-circle role ${code(rbac.circleRole)} or higher`);

  const joined =
    clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`;
  return `${REQUIREMENTS_MARKER} authentication, plus ${joined}.`;
}

function applyAppTags(document: MutableDocument): void {
  const used = new Set<string>();
  forEachOperation(document, (operation) => {
    for (const tag of operation.tags ?? []) used.add(tag);
  });

  document.tags = OPENAPI_TAGS.filter((tag) => used.has(tag.name)).map(
    ({ name, description }) => ({ name, description }),
  );
  document['x-tagGroups'] = OPENAPI_TAG_GROUPS.map((group) => ({
    name: group.name,
    tags: group.tags.filter((tag) => used.has(tag)),
  })).filter((group) => group.tags.length > 0);
}
