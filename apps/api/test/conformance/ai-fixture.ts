// =============================================================================
// How MemoriaHub boots for the platform AI conformance suites (RETRO-E4, #607)
// =============================================================================
//
// The five runtime suites (`ai-kill-switch`, `ai-rbac-matrix`, `ai-secret-egress`,
// `ai-key-policy`, `ai-jobs-server-only`) drive THIS app's real router. The fixture answers
// the four questions they ask:
//
//   createAiApp     the real `AppModule` over the mocked database (`createTestApp`), with the
//                   platform's AI runtime harness wired in: `AiService`, `AiRunsService`,
//                   `AiConfigService` and `AiOutputWriter` are the harness's instances (the real
//                   classes over a scripted fake provider and in-memory tables), so "the
//                   deployment key was never used" is a fact about what the fake provider saw.
//                   Everything else (controllers, guards, the interceptor, the job handlers,
//                   the key, usable-model and usage services) is the app's real wiring. The same
//                   four the platform reference app and kvox replace.
//   createContext   the same app WITHOUT the harness (the admin surface).
//   createUser      a mock user whose grants are EXACTLY the seeded catalog's for the role
//                   (`prisma/catalog/permissions.json`, what `npm run prisma:seed` writes), not
//                   the older hand-kept mock matrix: an administrator is `admin` plus the
//                   `org_admin` membership every administrator holds.
//   openApiDocument the app's document (`createAppOpenApiDocument`), which the routes are
//                   DISCOVERED from, never hand-listed.
//
// MemoriaHub's own AI admin routes live under `/api/admin/memoriahub-ai/*`, outside the slice's
// `/api/ai` and `/api/admin/ai` prefixes, so the suites never see them (they are pinned by
// test/ai/ai-platform-mount.integration.spec.ts).
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JwtService } from '@nestjs/jwt';
import { AiConfigService, AiOutputWriter, AiRunsService, AiService } from '@marinoscar/platform-api/ai';
import {
  createAiRuntimeHarness,
  HARNESS_OTHER_USER,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiConformanceApp,
  type AiConformanceContext,
  type AiConformanceFixture,
  type AiConformanceNestApp,
  type AiConformanceOpenApiDocument,
  type AiRuntimeHarness,
  type AiRuntimeHarnessOptions,
} from '@marinoscar/platform-api/ai/testing';

import { createAppOpenApiDocument } from '../../src/openapi/document';
import { setupBaseMocks, setupMockUser } from '../fixtures/mock-setup.helper';
import { MOCK_DEFAULT_ORG_ID } from '../fixtures/test-data.factory';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

interface PermissionCatalog {
  rolePermissions: Record<string, string[]>;
}

const CATALOG = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'prisma', 'catalog', 'permissions.json'), 'utf8'),
) as PermissionCatalog;

const seeded = (role: string): string[] => CATALOG.rolePermissions[role] ?? [];

/** The permissions each role is seeded with; an administrator also holds `org_admin`. */
export const AI_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  admin: [...new Set([...seeded('admin'), ...seeded('org_admin')])].sort(),
  contributor: [...seeded('contributor')].sort(),
  viewer: [...seeded('viewer')].sort(),
};

type HarnessSnapshot = { policy: string; script: unknown; delayMs: number };

/** Reaches the fake provider's private script and delay: the harness exposes no setter for either. */
function fakeInternals(harness: AiRuntimeHarness): {
  script: unknown;
  scriptCursor: number;
  options: { delayMs?: number };
} {
  return harness.fake as unknown as { script: unknown; scriptCursor: number; options: { delayMs?: number } };
}

/** The models the harness's user key reaches by default: every catalog model of the fake provider. */
function defaultReachable(options: AiRuntimeHarnessOptions): string[] {
  if (options.models) {
    return options.models.filter((model) => (model.provider ?? 'openai') === 'openai').map((model) => model.modelId);
  }
  return [
    'fake-model',
    'fake-embedding-model',
    'fake-image-model',
    'fake-transcription-model',
    'fake-speech-model',
    'fake-realtime-model',
  ];
}

/** Boots the app with the AI harness wired in; listening, for the streaming cases. */
async function createAiApp(options: AiRuntimeHarnessOptions = {}): Promise<AiConformanceApp> {
  const harness = createAiRuntimeHarness(options);
  const internals = fakeInternals(harness);
  const initial: HarnessSnapshot = {
    policy: JSON.stringify(harness.policy),
    script: internals.script,
    delayMs: internals.options.delayMs ?? 0,
  };
  const initialOrgKey = options.orgKey === true;

  const context = await createTestApp({
    useMockDatabase: true,
    overrideProviders: [
      { provide: AiService, useValue: harness.ai },
      { provide: AiRunsService, useValue: harness.runs },
      { provide: AiConfigService, useValue: harness.aiConfig },
      { provide: AiOutputWriter, useValue: harness.outputs },
    ],
  });

  await context.app.listen(0, '127.0.0.1');
  const baseUrl = await context.app.getUrl();

  return {
    context: context as unknown as AiConformanceContext,
    harness,
    baseUrl,
    script(next) {
      internals.script = next;
      internals.scriptCursor = 0;
    },
    setDelay(ms) {
      internals.options.delayMs = ms;
    },
    reset() {
      // The shared mocked Prisma client and its user registry are process-global: reset them so
      // the suite's `beforeEach` re-seeds users on a clean slate.
      resetPrismaMock();
      setupBaseMocks();

      harness.fake.reset();
      internals.script = initial.script;
      internals.scriptCursor = 0;
      internals.options.delayMs = initial.delayMs;

      harness.usageEvents.length = 0;
      harness.runRows.length = 0;
      harness.enqueued.length = 0;

      // `setPolicy` mutates the policy in place: restore the initial one (it drops the config cache).
      harness.setPolicy(JSON.parse(initial.policy));

      for (const userId of [HARNESS_USER, HARNESS_OTHER_USER]) harness.removeUserKeys(userId);
      if (options.userKey ?? true) {
        harness.addUserKey(HARNESS_USER, HARNESS_USER_KEY, options.reachable ?? defaultReachable(options));
      }
      harness.setOrgKey(initialOrgKey ? 'sk-org-admin-key-9999' : null);
      harness.clearOrgPolicies();
      harness.clearTenantKeys();
      harness.clearAiConfigWriters();
      harness.storage.reset();
      harness.storage.setConfigured(true);
      harness.orgKeys.getKey.mockClear();
    },
    async close() {
      await closeTestApp(context);
    },
  };
}

export const aiConformanceFixture: AiConformanceFixture = {
  createAiApp,
  createContext: (contextOptions) =>
    createTestApp({
      useMockDatabase: true,
      overrideProviders: contextOptions?.overrideProviders,
    }) as unknown as Promise<AiConformanceContext>,
  closeContext: (context) => closeTestApp(context as unknown as TestContext),
  async createUser(context, { id, roleName }) {
    const role = roleName as 'admin' | 'contributor' | 'viewer';
    const permissionNames = AI_ROLE_PERMISSIONS[role];
    if (!permissionNames) throw new Error(`aiConformanceFixture.createUser: unknown role "${roleName}"`);
    const user = setupMockUser({
      ...(id ? { id } : {}),
      // Unique per call: the registry is searched by email too.
      email: `${role}-${id ?? Math.random().toString(36).slice(2)}@example.test`,
      roleName: role,
      permissionNames: [...permissionNames],
    });
    const jwt = (context as unknown as TestContext).module.get<JwtService>(JwtService);
    const accessToken = jwt.sign({ sub: user.id, email: user.email, roles: user.roles });
    return { id: user.id, accessToken };
  },
  openApiDocument: (app: AiConformanceNestApp) =>
    createAppOpenApiDocument(app as never) as unknown as AiConformanceOpenApiDocument,
  defaultOrgId: MOCK_DEFAULT_ORG_ID,
  rolePermissions: AI_ROLE_PERMISSIONS,
};
