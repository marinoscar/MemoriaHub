import { Readable } from 'node:stream';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { z } from 'zod';

import {
  MEMORIAHUB_AI_ERROR_CLASSES,
  MemoriahubAiError,
  MemoriahubRateLimitError,
  type MemoriahubAccessPort,
  type MemoriahubAiErrorClass,
  type MemoriahubAiPort,
  type MemoriahubAuditPort,
  type MemoriahubEventsPort,
  type MemoriahubIdentityPort,
  type MemoriahubJobsPort,
  type MemoriahubMetricsPort,
  type MemoriahubNotifyPort,
  type MemoriahubObjectStorePort,
  type MemoriahubScopeRole,
  type MemoriahubSecretsPort,
  type MemoriahubSettingsNamespaceDef,
  type MemoriahubSettingsPort,
  type MemoriahubWebhooksPort,
} from '../ports/index.js';

// =============================================================================
// describeMemoriahubPortsConformance (RETRO-J4, #610)
// =============================================================================
//
// The executable proof that a binding of the host ports is correct. The fakes of this package pass it,
// the web edition's adapters (`apps/api/src/platform-memoriahub/`) pass it, and a bare-host author runs it
// against theirs. Test-runner neutral: the caller hands over `describe`, `it` and `expect`, so it works
// under Jest and Vitest alike.
//
// Each port has a section. A section needs the port from the factory plus the few hooks the kit cannot
// invent (how to provoke a failure, which scope has which member). A hook a host cannot offer is simply
// left out and the rule that needs it is skipped; a port the factory omits fails its section unless it is
// named in `options.skip`.
// =============================================================================

/** Patterns that would mean a credential leaked into an error, an event or a status. */
const KEY_PATTERNS: readonly RegExp[] = [/sk-[A-Za-z0-9]{10,}/, /ghp_|gho_|github_pat_/, /AIza[0-9A-Za-z_-]{20,}/];

/**
 * The test runner's functions, so the kit runs under Jest or Vitest.
 *
 * @stability experimental
 */
export interface MemoriahubConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * What the kit needs to test the job port.
 *
 * @stability experimental
 */
export interface MemoriahubJobsUnderTest {
  /** The port. */
  port: MemoriahubJobsPort;
  /** Runs every runnable job to completion (a worker pass). */
  drain(): Promise<void>;
}

/**
 * What the kit needs to test the model port.
 *
 * @stability experimental
 */
export interface MemoriahubAiUnderTest {
  /** The port. */
  port: MemoriahubAiPort;
  /** The user to call as. */
  userId?: string;
  /** The feature to call under (registered by the kit). */
  feature?: string;
  /**
   * Arranges for the next call to fail with the given class, and returns whether the host can produce it.
   * A class the host cannot produce is skipped.
   */
  failNextWith?(errorClass: MemoriahubAiErrorClass): boolean | Promise<boolean>;
}

/**
 * What the kit needs to test the object-store port.
 *
 * @stability experimental
 */
export interface MemoriahubObjectStoreUnderTest {
  /** The port. */
  port: MemoriahubObjectStorePort;
}

/**
 * The scopes and people the access rules run against.
 *
 * @stability experimental
 */
export interface MemoriahubAccessFixture {
  /** A shared scope the people below belong to (or not). */
  scopeId: string;
  /** A member with role `viewer`. */
  viewerId: string;
  /** A member with role `editor`. */
  editorId: string;
  /** A member with role `admin`. */
  adminId: string;
  /** A user who is not a member. */
  outsiderId: string;
  /** A scope id that does not exist. */
  unknownScopeId: string;
  /** A permission string that bypasses scope membership (a system administrator's). */
  bypassPermission: string;
}

/**
 * Grants for the record rules: the grantee may `read` the record but not `write` it.
 *
 * @stability experimental
 */
export interface MemoriahubGrantFixture {
  /** The user holding the grant. */
  granteeId: string;
  /** A record the grantee may read. */
  mediaItemId: string;
  /** A record the grantee holds no grant on. */
  otherMediaItemId: string;
}

/**
 * What the kit needs to test the access port.
 *
 * @stability experimental
 */
export interface MemoriahubAccessUnderTest {
  /** The port. */
  port: MemoriahubAccessPort;
  /** The scopes and people. */
  scope: MemoriahubAccessFixture;
  /** Grants, when the host has any (a bare host binds a policy with none and omits this). */
  grants?: MemoriahubGrantFixture;
}

/**
 * What the kit needs to test the identity port.
 *
 * @stability experimental
 */
export interface MemoriahubIdentityUnderTest {
  /** The port. */
  port: MemoriahubIdentityPort;
  /** A request that carries no credentials. */
  anonymous: ExecutionContext;
  /** A request that carries valid credentials, when the host can build one. */
  authenticated?: ExecutionContext;
  /** A permission the authenticated principal holds and one it lacks. */
  permissions?: { granted: string; notGranted: string };
}

/**
 * What the kit needs to test the notification port.
 *
 * @stability experimental
 */
export interface MemoriahubNotifyUnderTest {
  /** The port. */
  port: MemoriahubNotifyPort;
  /** An event the kit registers and a recipient to raise it for. */
  event: { key: string; userId: string };
}

/**
 * What the kit needs to test the settings port.
 *
 * @stability experimental
 */
export interface MemoriahubSettingsUnderTest {
  /** The port. */
  port: MemoriahubSettingsPort;
  /** Namespaces to declare through `registerNamespace` before the rules run. */
  namespaces?: MemoriahubSettingsNamespaceDef[];
  /** A system namespace the host knows and a valid patch for it. */
  system?: { name: string; patch: Record<string, unknown>; actorUserId: string };
  /** A user namespace the host knows and a valid patch for it. */
  user?: { name: string; userId: string; patch: Record<string, unknown> };
}

/**
 * What the kit needs to test the secrets port.
 *
 * @stability experimental
 */
export interface MemoriahubSecretsUnderTest {
  /** The port. */
  port: MemoriahubSecretsPort;
  /** A purpose to register and use. */
  purpose: string;
  /** The secret name within the purpose. */
  name: string;
  /** The user recorded as the author of changes. */
  actorUserId: string;
}

/**
 * The ports a host (or a fake) offers to the kit. Build it fresh on every call: each test gets its own.
 *
 * @stability experimental
 */
export interface MemoriahubPortsUnderTest {
  /** The job port. */
  jobs?: MemoriahubJobsUnderTest;
  /** The model port. */
  ai?: MemoriahubAiUnderTest;
  /** The object-store port. */
  objectStore?: MemoriahubObjectStoreUnderTest;
  /** The access port. */
  access?: MemoriahubAccessUnderTest;
  /** The identity port. */
  identity?: MemoriahubIdentityUnderTest;
  /** The notification port. */
  notify?: MemoriahubNotifyUnderTest;
  /** The event port. */
  events?: { port: MemoriahubEventsPort };
  /** The settings port. */
  settings?: MemoriahubSettingsUnderTest;
  /** The secrets port. */
  secrets?: MemoriahubSecretsUnderTest;
  /** The audit port. */
  audit?: { port: MemoriahubAuditPort };
  /** The webhook port. */
  webhooks?: { port: MemoriahubWebhooksPort };
  /** The metrics port. */
  metrics?: { port: MemoriahubMetricsPort };
  /** Releases whatever the test built. */
  dispose?(): Promise<void> | void;
}

/**
 * The names of the ports a section exists for.
 *
 * @stability experimental
 */
export type MemoriahubConformancePort =
  | 'jobs'
  | 'ai'
  | 'objectStore'
  | 'access'
  | 'identity'
  | 'notify'
  | 'events'
  | 'settings'
  | 'secrets'
  | 'audit'
  | 'webhooks'
  | 'metrics';

/**
 * Options of {@link describeMemoriahubPortsConformance}.
 *
 * @stability experimental
 */
export interface MemoriahubConformanceOptions {
  /** Ports to leave out (for example `webhooks` on a host that binds the default no-op). */
  skip?: MemoriahubConformancePort[];
}

/** Reads a stream into a string. */
async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

let counter = 0;
const unique = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

/**
 * Runs the conformance rules of every port a factory offers.
 *
 * @param name - what is under test (`the in-memory fakes`, `the web edition adapters`).
 * @param factory - builds a fresh set of ports for each test.
 * @param harness - the test runner's `describe`, `it` and `expect`; the globals when omitted.
 * @param options - ports to skip.
 * @stability experimental
 */
export function describeMemoriahubPortsConformance(
  name: string,
  factory: () => MemoriahubPortsUnderTest | Promise<MemoriahubPortsUnderTest>,
  harness?: MemoriahubConformanceHarness,
  options: MemoriahubConformanceOptions = {},
): void {
  const h = harness ?? (globalThis as unknown as MemoriahubConformanceHarness);
  const skipped = new Set(options.skip ?? []);

  /** Declares one rule: builds the ports, runs the body, disposes. */
  const rule = <K extends MemoriahubConformancePort>(
    port: K,
    title: string,
    body: (under: NonNullable<MemoriahubPortsUnderTest[K]>) => Promise<void> | void,
  ): void => {
    if (skipped.has(port)) return;
    h.it(title, async () => {
      const ports = await factory();
      try {
        const under = ports[port];
        if (under === undefined) throw new Error(`The factory offers no "${port}" port; name it in options.skip to leave it out`);
        await body(under as NonNullable<MemoriahubPortsUnderTest[K]>);
      } finally {
        await ports.dispose?.();
      }
    });
  };

  h.describe(`Memoriahub ports: ${name}`, () => {
    // ---- jobs ----------------------------------------------------------------
    h.describe('jobs', () => {
      rule('jobs', 'collapses two enqueues of the same type and subject into one job', async ({ port }) => {
        const type = unique('conf.dedup');
        port.registerHandler({ type, async process() {} });
        const first = await port.enqueue({ type, subjectType: 'media_item', subjectId: 'item-1', payload: {} });
        const second = await port.enqueue({ type, subjectType: 'media_item', subjectId: 'item-1', payload: {} });
        h.expect(first.deduplicated).toBe(false);
        h.expect(second.deduplicated).toBe(true);
        h.expect(second.id).toBe(first.id);
      });

      rule('jobs', 'keeps distinct work distinct with skipDedup', async ({ port }) => {
        const type = unique('conf.skip');
        port.registerHandler({ type, async process() {} });
        const first = await port.enqueue({ type, subjectType: 'media_item', subjectId: 'item-2', payload: {}, skipDedup: true });
        const second = await port.enqueue({ type, subjectType: 'media_item', subjectId: 'item-2', payload: {}, skipDedup: true });
        h.expect(second.id).not.toBe(first.id);
        h.expect(second.deduplicated).toBe(false);
      });

      rule('jobs', 'runs a registered handler and reports the settled job', async ({ port, drain }) => {
        const type = unique('conf.run');
        const seen: unknown[] = [];
        const settled: Array<{ type: string; status: string }> = [];
        port.registerHandler({ type, async process(job) { seen.push(job.payload); } });
        port.onSettled((event) => {
          if (event.type === type) settled.push({ type: event.type, status: event.status });
        });
        h.expect(port.isRegistered(type)).toBe(true);
        await port.enqueue({ type, subjectType: 'media_item', subjectId: 'item-3', payload: { mediaItemId: 'item-3' } });
        await drain();
        h.expect(seen).toEqual([{ mediaItemId: 'item-3' }]);
        h.expect(settled).toEqual([{ type, status: 'succeeded' }]);
      });

      rule('jobs', 'fails a job terminally once its attempts are spent, and reports it', async ({ port, drain }) => {
        const type = unique('conf.fail');
        let calls = 0;
        const settled: string[] = [];
        port.registerHandler({
          type,
          profile: { maxRuntimeMs: 60_000, maxAttempts: 2 },
          async process() {
            calls += 1;
            throw new Error('boom');
          },
        });
        port.onSettled((event) => {
          if (event.type === type) settled.push(`${event.status}:${event.lastError}`);
        });
        await port.enqueue({ type, subjectType: 'media_item', subjectId: 'item-4', payload: {} });
        await drain();
        h.expect(calls).toBe(2);
        h.expect(settled).toEqual(['failed:boom']);
      });

      rule('jobs', 'defers a job on a rate limit instead of failing it', async ({ port, drain }) => {
        const type = unique('conf.rate');
        const settled: string[] = [];
        port.registerHandler({
          type,
          profile: { maxRuntimeMs: 60_000, maxAttempts: 1 },
          async process() {
            throw new MemoriahubRateLimitError('tagging', 1000);
          },
        });
        port.onSettled((event) => {
          if (event.type === type) settled.push(event.status);
        });
        await port.enqueue({ type, subjectType: 'media_item', subjectId: 'item-5', payload: {} });
        await drain();
        h.expect(settled).toEqual([]);
        const active = await port.findActive({ types: [type], subjectType: 'media_item', subjectIds: ['item-5'] });
        h.expect(active.map((job) => job.subjectId)).toEqual(['item-5']);
      });

      rule('jobs', 'refuses an AI handler that is node-eligible', ({ port }) => {
        h.expect(() =>
          port.registerHandler({
            type: unique('conf.ai'),
            usesAi: true,
            nodeResultSchema: z.object({}),
            async persistNodeResult() {},
            async process() {},
          }),
        ).toThrow();
      });

      rule('jobs', 'refuses one half of the node pair', ({ port }) => {
        h.expect(() =>
          port.registerHandler({ type: unique('conf.half'), nodeResultSchema: z.object({}), async process() {} }),
        ).toThrow();
        h.expect(() =>
          port.registerHandler({ type: unique('conf.half'), async persistNodeResult() {}, async process() {} }),
        ).toThrow();
      });

      rule('jobs', 'finds pending jobs by subject and none once they settled', async ({ port, drain }) => {
        const type = unique('conf.active');
        port.registerHandler({ type, async process() {} });
        await port.enqueue({ type, subjectType: 'media_item', subjectId: 'item-6', payload: {} });
        const before = await port.findActive({ types: [type], subjectType: 'media_item', subjectIds: ['item-6'] });
        h.expect(before).toHaveLength(1);
        await drain();
        h.expect(await port.findActive({ types: [type], subjectType: 'media_item', subjectIds: ['item-6'] })).toEqual([]);
        h.expect(await port.findActive({ types: [type], subjectIds: [] })).toEqual([]);
      });

      rule('jobs', 'enqueues a housekeeping job once while one is in flight', async ({ port }) => {
        const type = unique('conf.housekeeping');
        port.registerHandler({ type, async process() {} });
        const first = await port.enqueueHousekeeping({ type, what: 'a test sweep' });
        const second = await port.enqueueHousekeeping({ type, what: 'a test sweep' });
        h.expect(first).not.toBeNull();
        h.expect(second).toBeNull();
      });

      rule('jobs', 'hands out distinct scratch paths that keep their suffix', ({ port }) => {
        const a = port.tempPath('.mp4');
        const b = port.tempPath('.mp4');
        h.expect(a.endsWith('.mp4')).toBe(true);
        h.expect(a).not.toBe(b);
      });
    });

    // ---- ai ------------------------------------------------------------------
    h.describe('ai', () => {
      rule('ai', 'answers a text request and never returns key material', async ({ port, userId, feature }) => {
        port.registerFeature({ id: feature ?? 'conformance', label: 'Conformance', systemCalls: true });
        const client = port.forUser(userId ?? 'user-1', { feature: feature ?? 'conformance' });
        const response = await client.respond({ input: 'Say hello' });
        h.expect(typeof response.outputText).toBe('string');
        for (const pattern of KEY_PATTERNS) h.expect(JSON.stringify(response)).not.toMatch(pattern);
      });

      rule('ai', 'serves a system call with no acting user', async ({ port, feature }) => {
        port.registerFeature({ id: feature ?? 'conformance', label: 'Conformance', systemCalls: true });
        const response = await port.forSystem({ feature: feature ?? 'conformance', orgId: null }).respond({ input: 'Say hello' });
        h.expect(typeof response.outputText).toBe('string');
      });

      rule('ai', 'streams text, then tool calls, then exactly one done', async ({ port, userId, feature }) => {
        port.registerFeature({ id: feature ?? 'conformance', label: 'Conformance', systemCalls: true });
        const client = port.forUser(userId ?? 'user-1', { feature: feature ?? 'conformance' });
        const events = [];
        for await (const event of await client.openStream({ input: 'Find beaches' })) events.push(event);
        h.expect(events.length).toBeGreaterThan(0);
        h.expect(events[events.length - 1]!.type).toBe('done');
        h.expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      });

      rule('ai', 'returns one vector per input, in order', async ({ port, userId, feature }) => {
        port.registerFeature({ id: feature ?? 'conformance', label: 'Conformance', systemCalls: true });
        const client = port.forUser(userId ?? 'user-1', { feature: feature ?? 'conformance' });
        const result = await client.embed({ model: 'text-embedding-3-small', input: ['one', 'two'] });
        h.expect(result.vectors).toHaveLength(2);
      });

      rule('ai', 'declares a feature idempotently', ({ port }) => {
        const feature = { id: unique('conf_feature'), label: 'Once', systemCalls: true };
        port.registerFeature(feature);
        h.expect(() => port.registerFeature(feature)).not.toThrow();
      });

      rule('ai', 'fails with a classified MemoriahubAiError that holds no key material', async (under) => {
        const { port, userId, feature, failNextWith } = under;
        if (!failNextWith) return;
        port.registerFeature({ id: feature ?? 'conformance', label: 'Conformance', systemCalls: true });
        const client = port.forUser(userId ?? 'user-1', { feature: feature ?? 'conformance' });
        for (const errorClass of MEMORIAHUB_AI_ERROR_CLASSES) {
          if (!(await failNextWith(errorClass))) continue;
          let caught: unknown;
          try {
            await client.respond({ input: 'x' });
          } catch (error) {
            caught = error;
          }
          h.expect(caught).toBeInstanceOf(MemoriahubAiError);
          h.expect((caught as MemoriahubAiError).errorClass).toBe(errorClass);
          for (const pattern of KEY_PATTERNS) h.expect((caught as Error).message).not.toMatch(pattern);
        }
      });
    });

    // ---- object store --------------------------------------------------------
    h.describe('objectStore', () => {
      rule('objectStore', 'round-trips an object through the active store', async ({ port }) => {
        const { id, store } = await port.active();
        h.expect(typeof id).toBe('string');
        const key = `conformance/${unique('object')}.txt`;
        await store.upload(key, Readable.from([Buffer.from('hello bytes')]), { mimeType: 'text/plain', contentLength: 11 });
        h.expect(await store.exists(key)).toBe(true);
        h.expect(await store.size(key)).toBe(11);
        h.expect(await text(await store.download(key))).toBe('hello bytes');
        h.expect(typeof (await store.getSignedDownloadUrl(key, { expiresIn: 60 }))).toBe('string');
        await store.delete(key);
        h.expect(await store.exists(key)).toBe(false);
        await h.expect(store.delete(key)).resolves.toBeUndefined();
        h.expect(await store.size(key)).toBeNull();
      });

      rule('objectStore', 'deletes many objects and reports what it deleted', async ({ port }) => {
        const { store } = await port.active();
        const keys = [`conformance/${unique('a')}`, `conformance/${unique('b')}`];
        for (const key of keys) await store.upload(key, Readable.from([Buffer.from('x')]), { mimeType: 'text/plain' });
        const result = await store.deleteMany(keys);
        h.expect([...result.deleted].sort()).toEqual([...keys].sort());
        h.expect(result.failed).toEqual([]);
      });

      rule('objectStore', 'refuses to download a missing object', async ({ port }) => {
        const { store } = await port.active();
        await h.expect(store.download(`conformance/${unique('missing')}`)).rejects.toThrow();
      });

      rule('objectStore', 'resolves a recorded location, and the active store when none is recorded', async ({ port }) => {
        const active = await port.active();
        const none = await port.forLocation(null);
        h.expect(none.kind).toBe(active.store.kind);
        const recorded = await port.forLocation(active.id, active.store.getBucket());
        h.expect(typeof recorded.getBucket()).toBe('string');
      });

      rule('objectStore', 'declares key prefixes and processors idempotently', ({ port }) => {
        const def = { id: unique('conf-prefix'), prefix: `${unique('conf-prefix')}/`, owner: 'conformance', description: 'A conformance prefix' };
        port.registerKeyPrefixes([def]);
        h.expect(() => port.registerKeyPrefixes([def])).not.toThrow();
        h.expect(() =>
          port.registerProcessor({
            name: unique('conf-processor'),
            priority: 1000,
            canProcess: () => false,
            async process() {
              return { success: true };
            },
          }),
        ).not.toThrow();
      });
    });

    // ---- access --------------------------------------------------------------
    h.describe('access', () => {
      const roleRank: Record<MemoriahubScopeRole, number> = { viewer: 1, editor: 2, admin: 3 };

      rule('access', 'admits a member at or above the role and refuses one below it with 403', async ({ port, scope }) => {
        for (const [userId, role] of [[scope.viewerId, 'viewer'], [scope.editorId, 'editor'], [scope.adminId, 'admin']] as const) {
          for (const required of ['viewer', 'editor', 'admin'] as const) {
            const call = port.requireOwnerRole(userId, scope.scopeId, [], required);
            if (roleRank[role] >= roleRank[required]) {
              h.expect((await call).role).toBe(role);
            } else {
              await h.expect(call).rejects.toBeInstanceOf(ForbiddenException);
            }
          }
        }
      });

      rule('access', 'answers not-found, never forbidden, to a non-member and for an unknown scope', async ({ port, scope }) => {
        await h.expect(port.requireOwnerRole(scope.outsiderId, scope.scopeId, [], 'viewer')).rejects.toBeInstanceOf(NotFoundException);
        await h.expect(port.requireOwnerRole(scope.viewerId, scope.unknownScopeId, [], 'viewer')).rejects.toBeInstanceOf(NotFoundException);
      });

      rule('access', 'lets a bypass permission through without membership', async ({ port, scope }) => {
        h.expect(port.hasOwnerBypass([])).toBe(false);
        h.expect(port.hasOwnerBypass(null)).toBe(false);
        h.expect(port.hasOwnerBypass([scope.bypassPermission])).toBe(true);
        const access = await port.requireOwnerRole(scope.outsiderId, scope.scopeId, [scope.bypassPermission], 'admin');
        h.expect(access.isSuperAdmin).toBe(true);
      });

      rule('access', 'reports roles, scopes and members consistently', async ({ port, scope }) => {
        h.expect(await port.roleIn(scope.editorId, scope.scopeId)).toBe('editor');
        h.expect(await port.roleIn(scope.outsiderId, scope.scopeId)).toBeNull();
        h.expect(await port.scopesOf(scope.editorId)).toContain(scope.scopeId);
        h.expect(await port.scopesOf(scope.outsiderId)).not.toContain(scope.scopeId);
        h.expect(await port.writableScopesOf(scope.editorId)).toContain(scope.scopeId);
        h.expect(await port.writableScopesOf(scope.viewerId)).not.toContain(scope.scopeId);
        const members = await port.membersOf(scope.scopeId);
        h.expect(members.map((member) => member.userId).sort()).toEqual([scope.adminId, scope.editorId, scope.viewerId].sort());
        h.expect((await port.membersOf(scope.scopeId, ['admin'])).map((member) => member.userId)).toEqual([scope.adminId]);
        h.expect(await port.scopeExists(scope.scopeId)).toBe(true);
        h.expect(await port.scopeExists(scope.unknownScopeId)).toBe(false);
        h.expect((await port.allScopeIds())).toContain(scope.scopeId);
        h.expect(() => port.invalidateMembers([scope.editorId])).not.toThrow();
      });

      rule('access', 'lets a grant add access to one record and nothing else', async ({ port, scope, grants }) => {
        if (!grants) return;
        h.expect(await port.grantAllows(grants.granteeId, [], 'read', 'media_item', grants.mediaItemId)).toBe(true);
        h.expect(await port.grantAllows(grants.granteeId, [], 'write', 'media_item', grants.mediaItemId)).toBe(false);
        h.expect(await port.grantAllows(grants.granteeId, [], 'read', 'media_item', grants.otherMediaItemId)).toBe(false);
        h.expect(await port.grantsAllowAll(grants.granteeId, [], 'read', 'media_item', [grants.mediaItemId])).toBe(true);
        h.expect(await port.grantsAllowAll(grants.granteeId, [], 'read', 'media_item', [grants.mediaItemId, grants.otherMediaItemId])).toBe(false);
        h.expect(await port.grantsAllowAll(grants.granteeId, [], 'read', 'media_item', [])).toBe(false);
        h.expect(await port.grantAllows(scope.outsiderId, [], 'read', 'media_item', grants.mediaItemId)).toBe(false);
      });
    });

    // ---- identity ------------------------------------------------------------
    h.describe('identity', () => {
      rule('identity', 'answers null for a request with no credentials', async ({ port, anonymous }) => {
        h.expect(await port.authenticate(anonymous)).toBeNull();
      });

      rule('identity', 'normalises the principal of an authenticated request', async ({ port, authenticated }) => {
        if (!authenticated) return;
        const principal = await port.authenticate(authenticated);
        h.expect(principal).not.toBeNull();
        h.expect(typeof principal!.userId).toBe('string');
        h.expect(principal!.permissions instanceof Set).toBe(true);
        h.expect(Array.isArray(principal!.roles)).toBe(true);
      });

      rule('identity', 'reports permissions fresh from the host', async ({ port, authenticated, permissions }) => {
        if (!authenticated || !permissions) return;
        const principal = await port.authenticate(authenticated);
        h.expect(await port.hasPermission(principal!.userId, permissions.granted)).toBe(true);
        h.expect(await port.hasPermission(principal!.userId, permissions.notGranted)).toBe(false);
        h.expect(await port.permissionsOf(principal!.userId)).toContain(permissions.granted);
        h.expect(await port.hasPermission('00000000-0000-4000-8000-00000000dead', permissions.granted)).toBe(false);
      });
    });

    // ---- notify --------------------------------------------------------------
    h.describe('notify', () => {
      rule('notify', 'never throws, for a registered event or an unregistered one', async ({ port, event }) => {
        port.registerEvents([{ key: event.key, label: 'Conformance event', description: 'Raised by the kit', channels: ['inbox'] }]);
        port.registerEvents([{ key: event.key, label: 'Conformance event', description: 'Raised by the kit', channels: ['inbox'] }]);
        h.expect(() => port.notify(event.key, event.userId, { count: 1 })).not.toThrow();
        h.expect(() => port.notify('conformance.unregistered', event.userId, {})).not.toThrow();
        h.expect(() => port.notifyCounted(event.key, event.userId, { count: 1 }, { scopeId: 'scope-1', windowMs: 1000 })).not.toThrow();
        h.expect(() => port.notifyState(event.key, event.userId, { count: 3 }, { scopeId: 'scope-1' })).not.toThrow();
        h.expect(() => port.notifyAddress(event.key, 'person@example.test', {})).not.toThrow();
      });

      rule('notify', 'answers an awaited send with the rate-limit verdict and never rejects', async ({ port, event }) => {
        port.registerEvents([{ key: event.key, label: 'Conformance event', description: 'Raised by the kit', channels: ['inbox'] }]);
        const result = await port.notifyNow(event.key, event.userId, {});
        h.expect(typeof result.rateLimited).toBe('boolean');
        await h.expect(port.notifyNow('conformance.unregistered', event.userId, {})).resolves.toBeDefined();
      });

      rule('notify', 'registers email templates idempotently', ({ port }) => {
        const def = {
          name: unique('conf-template'),
          render: () => ({ subject: 's', html: '<p>h</p>', text: 't' }),
        };
        port.registerEmailTemplates([def]);
        h.expect(() => port.registerEmailTemplates([def])).not.toThrow();
      });
    });

    // ---- events --------------------------------------------------------------
    h.describe('events', () => {
      rule('events', 'delivers an event to a listener and stops after unsubscribe', async ({ port }) => {
        const name = `conformance.${unique('event')}`;
        const seen: unknown[] = [];
        const off = port.subscribe(name, (payload) => {
          seen.push(payload);
        });
        port.emit(name, { n: 1 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        h.expect(seen).toEqual([{ n: 1 }]);
        off();
        port.emit(name, { n: 2 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        h.expect(seen).toEqual([{ n: 1 }]);
      });

      rule('events', 'never lets a failing listener break the emitter or its neighbours', async ({ port }) => {
        const name = `conformance.${unique('event')}`;
        const seen: unknown[] = [];
        port.subscribe(name, () => {
          throw new Error('listener failed');
        });
        port.subscribe(name, (payload) => {
          seen.push(payload);
        });
        h.expect(() => port.emit(name, { ok: true })).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 20));
        h.expect(seen).toEqual([{ ok: true }]);
        h.expect(() => port.emit(`conformance.${unique('nobody')}`, {})).not.toThrow();
      });
    });

    // ---- settings ------------------------------------------------------------
    h.describe('settings', () => {
      rule('settings', 'reads a system namespace with a version, merges a patch and refuses a stale version', async ({ port, namespaces, system }) => {
        if (!system) return;
        for (const def of namespaces ?? []) port.registerNamespace(def);
        const before = await port.readSystem<Record<string, unknown>>(system.name);
        h.expect(typeof before.version).toBe('number');
        const after = await port.patchSystem(system.name, system.patch, { actorUserId: system.actorUserId });
        for (const [key, value] of Object.entries(system.patch)) h.expect((after.value as Record<string, unknown>)[key]).toEqual(value);
        h.expect(after.version).toBeGreaterThanOrEqual(before.version);
        const reread = await port.readSystem<Record<string, unknown>>(system.name);
        for (const [key, value] of Object.entries(system.patch)) h.expect(reread.value[key]).toEqual(value);
        await h.expect(
          port.patchSystem(system.name, system.patch, { actorUserId: system.actorUserId, ifMatchVersion: before.version - 1 }),
        ).rejects.toThrow();
      });

      rule('settings', 'reads and patches a user namespace', async ({ port, namespaces, user }) => {
        if (!user) return;
        for (const def of namespaces ?? []) port.registerNamespace(def);
        const patched = await port.patchUser<Record<string, unknown>>(user.userId, user.name, user.patch);
        for (const [key, value] of Object.entries(user.patch)) h.expect(patched[key]).toEqual(value);
        const reread = await port.readUser<Record<string, unknown>>(user.userId, user.name);
        for (const [key, value] of Object.entries(user.patch)) h.expect(reread[key]).toEqual(value);
      });

      rule('settings', 'answers an IANA zone for a user, failing open', async ({ port, user }) => {
        const zone = await port.readUserTimeZone(user?.userId ?? '00000000-0000-4000-8000-000000000001');
        h.expect(typeof zone).toBe('string');
        h.expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow();
      });
    });

    // ---- secrets -------------------------------------------------------------
    h.describe('secrets', () => {
      rule('secrets', 'never returns the value from status, and returns it only from get', async ({ port, purpose, name, actorUserId }) => {
        port.registerPurpose(purpose, 'Conformance purpose');
        port.registerPurpose(purpose, 'Conformance purpose');
        const secret = 'conformance-secret-value-0123456789';
        h.expect((await port.status(purpose, name)).configured).toBe(false);
        h.expect(await port.get(purpose, name)).toBeNull();
        await port.set(purpose, name, secret, actorUserId);
        const status = await port.status(purpose, name);
        h.expect(status.configured).toBe(true);
        h.expect(JSON.stringify(status)).not.toContain(secret);
        h.expect(await port.get(purpose, name)).toBe(secret);
        await port.delete(purpose, name, actorUserId);
        h.expect((await port.status(purpose, name)).configured).toBe(false);
        await h.expect(port.delete(purpose, name, actorUserId)).resolves.toBeUndefined();
      });
    });

    // ---- audit, webhooks, metrics ---------------------------------------------
    h.describe('audit', () => {
      rule('audit', 'records an event without throwing', async ({ port }) => {
        await h.expect(
          port.record({ actorUserId: null, action: 'conformance.checked', targetType: 'conformance', targetId: unique('target'), meta: { ok: true } }),
        ).resolves.toBeUndefined();
      });
    });

    h.describe('webhooks', () => {
      rule('webhooks', 'accepts an emit', async ({ port }) => {
        await h.expect(port.emit('conformance.checked', { id: 'x' }, { orgId: null })).resolves.toBeUndefined();
      });
    });

    h.describe('metrics', () => {
      rule('metrics', 'never throws on an add or a record, known metric or not', ({ port }) => {
        h.expect(() => port.add('mediaUploads', 1, { mediaType: 'photo' })).not.toThrow();
        h.expect(() => port.add('conformanceUnknown')).not.toThrow();
        h.expect(() => port.record('mediaUploadSize', 1024, { mediaType: 'photo' })).not.toThrow();
      });
    });
  });
}
