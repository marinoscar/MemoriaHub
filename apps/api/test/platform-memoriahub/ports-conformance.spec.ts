// =============================================================================
// describeMemoriahubPortsConformance against the web app's adapters (RETRO-J4, #610)
// =============================================================================
//
// The same kit `packages/memoriahub-api/test/ports-conformance.spec.ts` runs against the in-memory fakes,
// run against each adapter in `src/platform-memoriahub/`. What is real and what is a stand-in is listed in
// `platform-stand-ins.ts`: the adapters, the platform registries and the platform helpers are real; the
// I/O underneath (the `jobs` table, the model provider, the storage driver, memberships, credential rows,
// settings rows) is a stand-in. The real-database half is `ports-conformance.db.spec.ts`.
// =============================================================================

import 'reflect-metadata';

import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { AiError } from '@marinoscar/platform-api/ai';
import { isRegisteredNotificationChannel, registerPlatformNotificationChannels } from '@marinoscar/platform-api/notifications';
import { ObjectProcessorRegistry } from '@marinoscar/platform-api/storage';
import {
  describeMemoriahubPortsConformance,
  type MemoriahubPortsUnderTest,
} from '@marinoscar/memoriahub-api/testing';
import type { MemoriahubAiErrorClass } from '@marinoscar/memoriahub-api/ports';
import { z } from 'zod';

import '../../src/settings/registry';
import { DefaultOrgId } from '../../src/common/tenancy/default-org-id';
import { PlatformMemoriahubAccessAdapter } from '../../src/platform-memoriahub/access/platform-memoriahub-access.adapter';
import { PlatformMemoriahubAiAdapter } from '../../src/platform-memoriahub/ai/platform-memoriahub-ai.adapter';
import { PlatformMemoriahubAuditAdapter } from '../../src/platform-memoriahub/audit/platform-memoriahub-audit.adapter';
import { PlatformMemoriahubEventsAdapter } from '../../src/platform-memoriahub/events/platform-memoriahub-events.adapter';
import { PlatformMemoriahubIdentityAdapter } from '../../src/platform-memoriahub/identity/platform-memoriahub-identity.adapter';
import { PlatformMemoriahubJobsAdapter } from '../../src/platform-memoriahub/jobs/platform-memoriahub-jobs.adapter';
import { PlatformMemoriahubMetricsAdapter } from '../../src/platform-memoriahub/metrics/platform-memoriahub-metrics.adapter';
import { PlatformMemoriahubNotifyAdapter } from '../../src/platform-memoriahub/notify/platform-memoriahub-notify.adapter';
import { PlatformMemoriahubObjectStoreAdapter } from '../../src/platform-memoriahub/object-store/platform-memoriahub-object-store.adapter';
import { PlatformMemoriahubSecretsAdapter } from '../../src/platform-memoriahub/secrets/platform-memoriahub-secrets.adapter';
import { PlatformMemoriahubSettingsAdapter } from '../../src/platform-memoriahub/settings/platform-memoriahub-settings.adapter';
import { PlatformMemoriahubWebhooksAdapter } from '../../src/platform-memoriahub/webhooks/platform-memoriahub-webhooks.adapter';
import { OwnerAccessService } from '../../src/platform/sharing/owner-scope';
import { OwnerScopeSweepService } from '../../src/platform/sharing/owner-scope-sweep.service';
import { RecordAccessService } from '../../src/platform/sharing/record-access';
import { buildJobsStandIns, StandInStorageProvider } from './platform-stand-ins';

const ORG_ID = '00000000-0000-4000-8000-0000000000a0';

// The channels an event names must exist in the platform registry (the host core registers them at boot).
if (!isRegisteredNotificationChannel('browser')) registerPlatformNotificationChannels();

// ---- access: real owner-scope, record and sweep services over a stand-in membership read ------------------------

function accessUnderTest(): NonNullable<MemoriahubPortsUnderTest['access']> {
  const members = new Map<string, Record<string, 'viewer' | 'editor' | 'admin'>>([
    ['scope-1', { 'user-viewer': 'viewer', 'user-editor': 'editor', 'user-admin': 'admin' }],
  ]);
  const principalGroups = {
    groupsFor: async (principal: { userId: string }) =>
      [...members].flatMap(([groupId, roles]) => (roles[principal.userId] ? [{ groupId, role: roles[principal.userId] }] : [])),
    groupRoleFor: async (principal: { userId: string }, groupId: string) => members.get(groupId)?.[principal.userId] ?? null,
    invalidateUsers: () => undefined,
    enrich: async (principal: unknown) => principal,
  };
  const personal = {
    idOf: async () => null,
    ownerOf: async () => null,
    get: async () => null,
    page: async () => [],
  };
  const defaultOrg = { get: async () => ORG_ID } as unknown as DefaultOrgId;
  const owner = new OwnerAccessService(personal as never, principalGroups as never, defaultOrg);
  const grants = new Set(['user-grantee:read:media_item:item-granted']);
  const policy = {
    decide: async (principal: { userId: string }, action: string, ref: { type: string; id: string }) => ({
      allowed: grants.has(`${principal.userId}:${action}:${ref.type}:${ref.id}`),
      via: 'user_grant',
    }),
    decideMany: async (principal: { userId: string }, action: string, refs: Array<{ type: string; id: string }>) =>
      new Map(
        refs.map((ref) => [
          `${ref.type}:${ref.id}`,
          { allowed: grants.has(`${principal.userId}:${action}:${ref.type}:${ref.id}`), via: 'user_grant' },
        ]),
      ),
  };
  const records = new RecordAccessService(policy as never, principalGroups as never, {} as never, defaultOrg);
  const groupsService = {
    listForSystem: async () => ({ items: [{ id: 'scope-1', name: 'Library Alpha', createdById: null }], nextCursor: null }),
  };
  const membership = {
    membersForSystem: async (scopeId: string, opts: { roles?: string[] }) =>
      Object.entries(members.get(scopeId) ?? {})
        .map(([userId, role]) => ({ userId, role }))
        .filter((member) => !opts.roles || opts.roles.includes(member.role)),
  };
  const sweep = new OwnerScopeSweepService(groupsService as never, membership as never, personal as never, {} as never, defaultOrg);

  return {
    port: new PlatformMemoriahubAccessAdapter(owner, records, sweep),
    scope: {
      scopeId: 'scope-1',
      viewerId: 'user-viewer',
      editorId: 'user-editor',
      adminId: 'user-admin',
      outsiderId: 'user-outsider',
      unknownScopeId: 'scope-missing',
      bypassPermission: 'groups:admin',
    },
    grants: { granteeId: 'user-grantee', mediaItemId: 'item-granted', otherMediaItemId: 'item-other' },
  };
}

// ---- ai: the real adapter over a scripted platform AiService -------------------------------------------------

const CODE_OF: Partial<Record<MemoriahubAiErrorClass, ConstructorParameters<typeof AiError>[0]>> = {
  auth: 'AI_KEY_INVALID',
  refusal: 'AI_CONTENT_FILTERED',
  rate_limit: 'AI_RATE_LIMITED',
  not_configured: 'AI_DISABLED',
  key_missing: 'AI_KEY_REQUIRED',
  capability: 'AI_CAPABILITY_UNSUPPORTED',
  invalid_output: 'AI_STRUCTURED_OUTPUT_INVALID',
  other: 'AI_PROVIDER_UNAVAILABLE',
};

function aiUnderTest(): NonNullable<MemoriahubPortsUnderTest['ai']> {
  let failure: AiError | null = null;
  const take = (): void => {
    const next = failure;
    failure = null;
    if (next) throw next;
  };
  const response = { id: 'r1', provider: 'openai', model: 'gpt', output: [], outputText: 'hello', usage: { inputTokens: 3, outputTokens: 2 }, finishReason: 'stop' };
  const client = {
    respond: async () => {
      take();
      return response;
    },
    respondStructured: async () => {
      take();
      return { ...response, parsed: {} };
    },
    stream: () => {
      throw new Error('not used');
    },
    openStream: async () => {
      take();
      return (async function* () {
        yield { type: 'output_text.delta', delta: 'Looking' };
        yield { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search_media', arguments: '{"q":"beach"}' } };
        yield { type: 'response.completed', response: { ...response, output: [{ type: 'function_call', callId: 'c1', name: 'search_media', arguments: '{"q":"beach"}' }] } };
      })();
    },
    embed: async (req: { input: string | string[]; model: string }) => {
      take();
      const inputs = Array.isArray(req.input) ? req.input : [req.input];
      return { provider: 'openai', model: req.model, dimensions: 3, vectors: inputs.map(() => [0.1, 0.2, 0.3]) };
    },
    editImageInline: async () => ({ images: [{ data: new Uint8Array([1]), mimeType: 'image/jpeg' }] }),
    transcribeInline: async () => ({ text: 'hello', language: 'en' }),
  };
  const ai = { forUser: () => client, forSystem: () => client };

  return {
    port: new PlatformMemoriahubAiAdapter(ai as never),
    userId: 'user-1',
    feature: 'conformance',
    failNextWith: (errorClass) => {
      const code = CODE_OF[errorClass];
      if (!code) return false;
      failure = new AiError(code, `Scripted ${errorClass} failure`, errorClass === 'rate_limit' ? { retryAfterMs: 1000 } : undefined);
      return true;
    },
  };
}

// ---- identity: the real adapter over a stand-in JwtAuthGuard and user read ------------------------------------

const USER_ROW = {
  id: 'user-1',
  email: 'person.a@example.test',
  isActive: true,
  userRoles: [
    {
      role: {
        id: 'role-1',
        name: 'contributor',
        description: null,
        rolePermissions: [{ permission: { id: 'perm-1', name: 'media:read', description: null } }],
      },
    },
  ],
};

function requestContext(userId: string | null): ExecutionContext {
  const request: Record<string, unknown> = userId ? { standInUserId: userId } : {};
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function identityUnderTest(): NonNullable<MemoriahubPortsUnderTest['identity']> {
  const jwt = {
    canActivate: async (context: ExecutionContext) => {
      const request = context.switchToHttp().getRequest<Record<string, unknown>>();
      if (request['standInUserId'] !== USER_ROW.id) throw new UnauthorizedException('Authentication is required');
      request['user'] = USER_ROW;
      return true;
    },
  };
  const prisma = { user: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === USER_ROW.id ? USER_ROW : null) } };

  return {
    port: new PlatformMemoriahubIdentityAdapter(jwt as never, prisma as never),
    anonymous: requestContext(null),
    authenticated: requestContext(USER_ROW.id),
    permissions: { granted: 'media:read', notGranted: 'media:write' },
  };
}

// ---- jobs ---------------------------------------------------------------------------------------------------

function jobsUnderTest(): NonNullable<MemoriahubPortsUnderTest['jobs']> {
  const stand = buildJobsStandIns();
  const adapter = new PlatformMemoriahubJobsAdapter(
    stand.queue as never,
    stand.registry,
    stand.throttle,
    stand.scope as never,
    stand.queue as never,
    stand.events,
    stand.defaultOrg as never,
  );
  return { port: adapter, drain: () => stand.queue.drain() };
}

// ---- settings: the platform registries are real, the stored rows are a stand-in ---------------------------------

function settingsUnderTest(): NonNullable<MemoriahubPortsUnderTest['settings']> {
  let version = 1;
  const doc: Record<string, unknown> = { dedup: { hashMaxDistance: 6 } };
  const system = {
    getSettings: async () => ({ ...doc, version }),
    patchSettings: async (dto: Record<string, Record<string, unknown>>, _userId: string, expected?: number) => {
      if (expected !== undefined && expected !== version) throw new Error(`The settings changed since version ${expected}`);
      for (const [name, patch] of Object.entries(dto)) doc[name] = { ...(doc[name] as object), ...patch };
      version += 1;
      return { ...doc, version };
    },
  };
  const userDoc: Record<string, Record<string, unknown>> = {};
  const users = {
    getSettings: async (userId: string) => ({ memories: { emailDigestOptOut: false, ...(userDoc[userId] ?? {}) } }),
    patchSettings: async (userId: string, dto: { memories: Record<string, unknown> }) => {
      userDoc[userId] = { ...(userDoc[userId] ?? {}), ...dto.memories };
      return { memories: { emailDigestOptOut: false, ...userDoc[userId] } };
    },
  };
  const zones = { resolveUserTimeZone: async () => 'UTC' };

  return {
    port: new PlatformMemoriahubSettingsAdapter(system as never, users as never, zones as never),
    namespaces: [
      { scope: 'system', name: 'dedup', schema: z.object({ hashMaxDistance: z.number() }), defaults: { hashMaxDistance: 6 } },
      { scope: 'user', name: 'memories', schema: z.object({ emailDigestOptOut: z.boolean() }), defaults: { emailDigestOptOut: false } },
    ],
    system: { name: 'dedup', patch: { hashMaxDistance: 8 }, actorUserId: 'user-1' },
    user: { name: 'memories', userId: 'user-1', patch: { emailDigestOptOut: true } },
  };
}

// ---- the rest -------------------------------------------------------------------------------------------------

function webUnderTest(): MemoriahubPortsUnderTest {
  const provider = new StandInStorageProvider();
  const resolver = {
    getActiveProvider: async () => ({ id: provider.kind, provider }),
    getProviderFor: async () => provider,
    getInternalDownloadUrl: async () => null,
  };

  const credentialRows = new Map<string, { value: string; updatedAt: Date }>();
  const credentials = {
    getSecret: async (purpose: string, name: string) => credentialRows.get(`${purpose}/${name}`)?.value ?? null,
    setSecret: async (purpose: string, name: string, value: string) => {
      credentialRows.set(`${purpose}/${name}`, { value, updatedAt: new Date() });
    },
    deleteSecret: async (purpose: string, name: string) => {
      credentialRows.delete(`${purpose}/${name}`);
    },
    describe: async (purpose: string, name: string) => {
      const row = credentialRows.get(`${purpose}/${name}`);
      return row ? { hint: row.value.slice(-4), updatedAt: row.updatedAt, updatedByUserId: 'user-1' } : null;
    },
  };

  const notifications = {
    notify: async () => undefined,
    notifyCounted: async () => undefined,
    notifyState: async () => undefined,
    notifyAddress: async () => undefined,
    notifyNow: async () => ({ rateLimited: false, retryAfterMs: null }),
  };

  const bus = (() => {
    const listeners = new Map<string, Set<(payload: unknown) => unknown>>();
    return {
      publish: async (channel: string, payload: unknown) => {
        for (const listener of listeners.get(channel) ?? []) void Promise.resolve().then(() => listener(payload)).catch(() => undefined);
      },
      subscribe: (channel: string, handler: (payload: unknown) => unknown) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(handler);
        listeners.set(channel, set);
        return () => set.delete(handler);
      },
    };
  })();

  return {
    jobs: jobsUnderTest(),
    ai: aiUnderTest(),
    objectStore: { port: new PlatformMemoriahubObjectStoreAdapter(resolver as never, new ObjectProcessorRegistry()) },
    access: accessUnderTest(),
    identity: identityUnderTest(),
    notify: { port: new PlatformMemoriahubNotifyAdapter(notifications as never), event: { key: 'conformance.checked', userId: 'user-1' } },
    events: { port: new PlatformMemoriahubEventsAdapter(bus as never) },
    settings: settingsUnderTest(),
    secrets: { port: new PlatformMemoriahubSecretsAdapter(credentials as never), purpose: 'geo_provider', name: 'google', actorUserId: 'user-1' },
    audit: { port: new PlatformMemoriahubAuditAdapter({ record: async () => undefined }) },
    webhooks: { port: new PlatformMemoriahubWebhooksAdapter({ emit: async () => ({ matched: 0, queued: 0 }) } as never) },
    metrics: { port: new PlatformMemoriahubMetricsAdapter({ add: () => undefined, record: () => undefined } as never) },
  };
}

describeMemoriahubPortsConformance('the web app platform adapters', webUnderTest, { describe, it, expect });
