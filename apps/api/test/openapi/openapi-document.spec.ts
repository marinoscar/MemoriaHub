import { createTestApp, closeTestApp, TestContext } from '../helpers/test-app.helper';
import {
  createOpenApiDocument,
  isAuthenticatedOperation,
  SECURITY_SCHEMES,
} from '../../src/openapi/document';
import { OPENAPI_TAGS, OPENAPI_TAG_GROUPS } from '../../src/openapi/tags';
import { REQUIREMENTS_MARKER } from '../../src/openapi/rbac-docs';
import { RBAC_EXTENSION_KEY } from '../../src/auth/decorators/auth.decorator';
import { DocOperation, forEachOperation, MutableDocument } from '../../src/openapi/types';

/**
 * Boots the real AppModule once and asserts the document it produces.
 *
 * These are the guardrails the epic asked for: a spec that can silently rot is
 * the failure mode this whole feature exists to remove, so every claim the docs
 * page makes about itself (one admin-tag convention, no orphan tags, generated
 * RBAC lines, an error envelope everywhere) is checked here rather than by a
 * reviewer noticing.
 */
describe('OpenAPI document', () => {
  let context: TestContext;
  let document: MutableDocument;
  let operations: Array<{ path: string; method: string; operation: DocOperation }>;

  beforeAll(async () => {
    context = await createTestApp();
    document = createOpenApiDocument(context.app) as unknown as MutableDocument;

    operations = [];
    forEachOperation(document, (operation, path, method) => {
      operations.push({ path, method, operation });
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  it('produces a non-trivial document', () => {
    expect(operations.length).toBeGreaterThan(200);
  });

  describe('branding and metadata', () => {
    it('is titled after this product, not the scaffold it came from', () => {
      const info = document.info as { title: string; version: string; description: string };
      expect(info.title).toBe('MemoriaHub API');
      expect(info.description).toContain('MemoriaHub');
    });

    it('carries no trace of the "Enterprise App" template', () => {
      expect(JSON.stringify(document)).not.toMatch(/Enterprise App/i);
    });

    it('reports a real version rather than the hardcoded 1.0', () => {
      const { version } = document.info as { version: string };
      expect(version).not.toBe('1.0');
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('declares a same-origin server so the built-in client targets this deployment', () => {
      expect(document.servers).toEqual([
        expect.objectContaining({ url: '/' }),
      ]);
    });

    it('publishes OpenAPI 3.1, which zod v4 schemas require', () => {
      expect(document.openapi).toBe('3.1.0');
    });

    it('carries no 3.0-only `nullable` keyword, which a 3.1 consumer would ignore', () => {
      // Ignoring it means generating a non-nullable field — wrong about exactly
      // the values most likely to break a client.
      expect(JSON.stringify(document)).not.toContain('"nullable"');
    });

    it('omits the contact email rather than publishing an invalid empty one', () => {
      const contact = (document.info as { contact?: Record<string, unknown> }).contact;
      expect(contact).toBeDefined();
      expect(contact).not.toHaveProperty('email');
    });

    it('documents the getting-started essentials in the description', () => {
      const { description } = document.info as { description: string };
      // Each of these is a question a first-time caller has to answer before
      // they can make a single successful request.
      expect(description).toContain('pat_');
      expect(description).toContain('nod_');
      expect(description).toContain('RFC 8628');
      expect(description).toContain('nextCursor');
      expect(description).toContain('circle_admin');
    });
  });

  describe('tag taxonomy', () => {
    const usedTags = (): Set<string> => {
      const tags = new Set<string>();
      for (const { operation } of operations) {
        for (const tag of operation.tags ?? []) tags.add(tag);
      }
      return tags;
    };

    it('uses exactly one admin-tag naming convention', () => {
      const offenders = [...usedTags()].filter((tag) => /^Admin\s*[-—]/.test(tag));
      expect(offenders).toEqual([]);
    });

    it('declares every tag an operation actually uses', () => {
      const declared = new Set(OPENAPI_TAGS.map((tag) => tag.name));
      const undeclared = [...usedTags()].filter((tag) => !declared.has(tag));
      expect(undeclared).toEqual([]);
    });

    it('has no declared tag that no operation uses', () => {
      const used = usedTags();
      const orphaned = OPENAPI_TAGS.map((tag) => tag.name).filter((tag) => !used.has(tag));
      expect(orphaned).toEqual([]);
    });

    it('gives every declared tag a description', () => {
      const undescribed = (document.tags as Array<{ name: string; description?: string }>)
        .filter((tag) => !tag.description)
        .map((tag) => tag.name);
      expect(undescribed).toEqual([]);
    });

    it('places every tag in exactly one x-tagGroup', () => {
      const grouped = OPENAPI_TAG_GROUPS.flatMap((group) => group.tags);
      expect(new Set(grouped).size).toBe(grouped.length);
      expect(new Set(grouped)).toEqual(new Set(OPENAPI_TAGS.map((tag) => tag.name)));
      expect(document['x-tagGroups']).toEqual(OPENAPI_TAG_GROUPS);
    });
  });

  describe('operation ids', () => {
    it('gives every operation a namespaced id', () => {
      const missing = operations
        .filter(({ operation }) => !operation.operationId)
        .map(({ path, method }) => `${method} ${path}`);
      expect(missing).toEqual([]);
    });

    it('keeps operation ids unique, so a generated SDK has no colliding methods', () => {
      const seen = new Map<string, string>();
      const collisions: string[] = [];
      for (const { path, method, operation } of operations) {
        const id = operation.operationId as string;
        const previous = seen.get(id);
        if (previous) collisions.push(`${id}: ${previous} and ${method} ${path}`);
        else seen.set(id, `${method} ${path}`);
      }
      expect(collisions).toEqual([]);
    });

    it('drops the "Controller" noise a generator would otherwise bake into names', () => {
      const ids = operations.map(({ operation }) => operation.operationId as string);
      expect(ids.some((id) => /Controller_/.test(id))).toBe(false);
      expect(ids).toContain('auth_getProviders');
    });
  });

  describe('self-documenting RBAC', () => {
    const guarded = () =>
      operations.filter(({ operation }) => operation[RBAC_EXTENSION_KEY] !== undefined);
    const authenticated = () =>
      operations.filter(({ operation }) => isAuthenticatedOperation(operation));

    it('guards a substantial share of the surface', () => {
      expect(guarded().length).toBeGreaterThan(150);
    });

    it('states the requirements of every guarded operation in its description', () => {
      const silent = guarded()
        .filter(({ operation }) => !(operation.description ?? '').includes(REQUIREMENTS_MARKER))
        .map(({ path, method }) => `${method} ${path}`);
      expect(silent).toEqual([]);
    });

    it('names the actual permission a guarded operation requires', () => {
      const usersList = operations.find(
        ({ path, method }) => path === '/api/users' && method === 'get',
      );
      expect(usersList?.operation.description).toContain('`users:read`');
    });

    it('appends to the hand-written description rather than replacing it', () => {
      const withProse = guarded().find(({ operation }) =>
        (operation.description ?? '').split(REQUIREMENTS_MARKER)[0].trim().length > 0,
      );
      expect(withProse).toBeDefined();
    });

    it('states requirements on routes guarded by JwtAuthGuard alone too', () => {
      // A few auth-controller routes compose `@UseGuards(JwtAuthGuard)` with a
      // bare `@ApiBearerAuth(...)` rather than `@Auth()`; they are still
      // authenticated and must still say so.
      const silent = authenticated()
        .filter(({ operation }) => !(operation.description ?? '').includes(REQUIREMENTS_MARKER))
        .map(({ path, method }) => `${method} ${path}`);
      expect(silent).toEqual([]);
    });

    it('leaves public operations alone', () => {
      const providers = operations.find(
        ({ path, method }) => path === '/api/auth/providers' && method === 'get',
      );
      expect(providers?.operation.description ?? '').not.toContain(REQUIREMENTS_MARKER);
    });
  });

  describe('authentication schemes', () => {
    it('documents all three bearer credentials', () => {
      const schemes = (document.components as { securitySchemes: Record<string, unknown> })
        .securitySchemes;
      expect(Object.keys(schemes).sort()).toEqual(
        [
          SECURITY_SCHEMES.JWT_AUTH,
          SECURITY_SCHEMES.NODE_CREDENTIAL,
          SECURITY_SCHEMES.PAT_AUTH,
        ].sort(),
      );
    });

    it('offers session and PAT auth as alternatives on every authenticated operation', () => {
      const missing = operations
        .filter(({ operation }) => isAuthenticatedOperation(operation))
        .filter(({ operation }) => {
          const names = (operation.security ?? []).flatMap((entry) => Object.keys(entry));
          return (
            !names.includes(SECURITY_SCHEMES.JWT_AUTH) ||
            !names.includes(SECURITY_SCHEMES.PAT_AUTH)
          );
        })
        .map(({ path, method }) => `${method} ${path}`);
      expect(missing).toEqual([]);
    });

    it('offers the node credential on /api/nodes routes and nowhere else', () => {
      for (const { path, operation } of operations) {
        const names = (operation.security ?? []).flatMap((entry) => Object.keys(entry));
        const offered = names.includes(SECURITY_SCHEMES.NODE_CREDENTIAL);
        const isNodeRoute = /^\/api\/nodes(\/|$)/.test(path);
        expect(offered).toBe(isNodeRoute && isAuthenticatedOperation(operation));
      }
    });
  });

  describe('error envelope', () => {
    it('publishes the shared ErrorDto schema', () => {
      const schemas = (document.components as { schemas: Record<string, unknown> }).schemas;
      expect(schemas.ErrorDto).toBeDefined();
    });

    it('documents the envelope as the default response on every operation', () => {
      const missing = operations
        .filter(({ operation }) => {
          const fallback = operation.responses?.default as
            | { content?: Record<string, { schema?: { $ref?: string } }> }
            | undefined;
          return (
            fallback?.content?.['application/json']?.schema?.$ref !==
            '#/components/schemas/ErrorDto'
          );
        })
        .map(({ path, method }) => `${method} ${path}`);
      expect(missing).toEqual([]);
    });

    it('documents 401 and 403 on operations guarded by @Auth()', () => {
      const missing = operations
        .filter(({ operation }) => operation[RBAC_EXTENSION_KEY] !== undefined)
        .filter(({ operation }) => !operation.responses?.['401'] || !operation.responses?.['403'])
        .map(({ path, method }) => `${method} ${path}`);
      expect(missing).toEqual([]);
    });
  });

  describe('response envelope accuracy', () => {
    it('documents GET /api/auth/providers with the { data } wrapper the handler returns', () => {
      const providers = operations.find(
        ({ path, method }) => path === '/api/auth/providers' && method === 'get',
      );
      const schema = (
        providers?.operation.responses?.['200'] as {
          content?: Record<string, { schema?: { properties?: Record<string, unknown> } }>;
        }
      )?.content?.['application/json']?.schema;
      expect(schema?.properties).toHaveProperty('data');
    });
  });
});
