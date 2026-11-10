/**
 * Job type snapshot (RETRO-C1, #575): "job type strings are permanent".
 *
 * Rows of every type below exist in production history (`jobs.type`), and the
 * type string is what a worker dispatches on, so a handler may be re-homed or
 * rewritten but its string never changes and never disappears. The spec pins:
 *
 *   - the 42 type strings the app registers a handler for, plus the three
 *     notification types RETRO-D3 retired (still dispatching, as no-ops),
 *   - which of them are node-eligible (a handler that carries BOTH
 *     `nodeResultSchema` and `persistNodeResult`; eligibility is derived,
 *     there is no flag), and
 *   - which carry the `canDelete` admin-delete veto.
 *
 * It instantiates every real handler class (the constructors are pure DI
 * assignment, so a no-arg construction is safe) and reads the same values the
 * queue reads. Cutover proof (RETRO-C1): the same expectations hold on the
 * LEGACY registry and on the PLATFORM `JobHandlerRegistry` the adapter fills,
 * because the adapter forwards the node pair only when the legacy handler has
 * both, and the platform derives eligibility (`serverOnlyTypes()`) from that pair.
 *
 * `job_history_purge` is the one type whose handler is retired: the platform's
 * `job.history.purge` replaced the purge, and `RetiredJobTypeHandler` keeps the
 * string dispatching (a pending row settles as a no-op) so a row of it never
 * sits in the queue unclaimable.
 */

import { ConfigService } from '@nestjs/config';
import { JobHandlerRegistry, ProviderThrottleService } from '@marinoscar/platform-api/jobs';

import { EnrichmentHandlerRegistry } from '../../src/enrichment/enrichment-handler.registry';
import type { EnrichmentHandler } from '../../src/enrichment/enrichment-handler.interface';
import {
  LegacyEnrichmentHandlerAdapter,
  PROVIDER_KEY_SERVER_ONLY_TYPES,
} from '../../src/platform/jobs/legacy-handlers.adapter';
import {
  RETIRED_NOTIFICATION_JOB_TYPES,
  RetiredNotificationJobTypes,
} from '../../src/platform/notifications/retired-notification-job-types';
import {
  ALL_HANDLER_CLASSES,
  EXPECTED_RETIRED_NOTIFICATION_TYPES,
  EXPECTED_CAN_DELETE_TYPES,
  EXPECTED_JOB_TYPES,
  EXPECTED_NODE_ELIGIBLE_TYPES,
} from './legacy-handlers.fixture';


describe('job type snapshot (job type strings are permanent)', () => {
  let handlers: EnrichmentHandler[];
  let registry: EnrichmentHandlerRegistry;

  beforeEach(() => {
    registry = new EnrichmentHandlerRegistry();
    handlers = ALL_HANDLER_CLASSES.map(
      (HandlerClass) => new (HandlerClass as unknown as new () => EnrichmentHandler)(),
    );
    for (const handler of handlers) registry.register(handler);
  });

  it('registers exactly the 42 pinned type strings', () => {
    expect(ALL_HANDLER_CLASSES).toHaveLength(42);
    expect(registry.types().sort()).toEqual([...EXPECTED_JOB_TYPES].sort());
  });

  it('has no duplicate type string', () => {
    const types = handlers.map((handler) => handler.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('pins the node-eligible types (node-result pair present)', () => {
    const eligible = handlers
      .filter((handler) => handler.nodeResultSchema && typeof handler.persistNodeResult === 'function')
      .map((handler) => handler.type)
      .sort();
    expect(eligible).toEqual([...EXPECTED_NODE_ELIGIBLE_TYPES].sort());
  });

  it('derives the server-only set as the complement of the node-eligible set', () => {
    const serverOnly = registry.serverOnlyTypes().sort();
    const expected = EXPECTED_JOB_TYPES.filter((type) => !EXPECTED_NODE_ELIGIBLE_TYPES.includes(type)).sort();
    expect(serverOnly).toEqual(expected);
  });

  it('never carries only half of the node-result pair', () => {
    for (const handler of handlers) {
      const hasSchema = handler.nodeResultSchema !== undefined;
      const hasPersist = typeof handler.persistNodeResult === 'function';
      expect({ type: handler.type, hasSchema }).toEqual({ type: handler.type, hasSchema: hasPersist });
    }
  });

  it('pins the canDelete veto types', () => {
    const vetoes = handlers
      .filter((handler) => typeof handler.canDelete === 'function')
      .map((handler) => handler.type)
      .sort();
    expect(vetoes).toEqual([...EXPECTED_CAN_DELETE_TYPES].sort());
  });
});

describe('job type snapshot through the platform adapter (RETRO-C1)', () => {
  let platform: JobHandlerRegistry;
  let legacy: EnrichmentHandlerRegistry;

  beforeEach(() => {
    platform = new JobHandlerRegistry();
    const throttle = new ProviderThrottleService(new ConfigService());
    const prisma = {} as never;
    legacy = new EnrichmentHandlerRegistry(new LegacyEnrichmentHandlerAdapter(platform, throttle, prisma));
    for (const HandlerClass of ALL_HANDLER_CLASSES) {
      legacy.register(new (HandlerClass as unknown as new () => EnrichmentHandler)());
    }
  });

  it('dispatches every pinned type string on the platform registry', () => {
    expect(platform.types().sort()).toEqual([...EXPECTED_JOB_TYPES].sort());
  });

  // RETRO-C2 (#581): no provider key is delivered to a node. The three types whose legacy class still
  // carries the node pair are server-only on the platform until their native handlers land
  // (RETRO-C4: the AI tagging types; RETRO-C6: geocode, back to nodes through the secret broker).
  const PLATFORM_NODE_ELIGIBLE_TYPES = EXPECTED_NODE_ELIGIBLE_TYPES.filter(
    (type) => !PROVIDER_KEY_SERVER_ONLY_TYPES.has(type),
  );

  it('pins the provider-key types that are server-only for now', () => {
    expect([...PROVIDER_KEY_SERVER_ONLY_TYPES].sort()).toEqual(['auto_tagging', 'geocode', 'video_auto_tagging']);
    const serverOnly = platform.serverOnlyTypes();
    for (const type of PROVIDER_KEY_SERVER_ONLY_TYPES) {
      expect(serverOnly).toContain(type);
      const handler = platform.get(type)!;
      expect(handler.nodeResultSchema).toBeUndefined();
      expect(handler.persistNodeResult).toBeUndefined();
    }
  });

  it('keeps node eligibility: the platform derives the complement of the node-eligible set', () => {
    const expected = EXPECTED_JOB_TYPES.filter((type) => !PLATFORM_NODE_ELIGIBLE_TYPES.includes(type)).sort();
    expect(platform.serverOnlyTypes().sort()).toEqual(expected);
  });

  it('forwards the node pair only for the node-eligible types', () => {
    for (const type of EXPECTED_JOB_TYPES) {
      const handler = platform.get(type)!;
      const eligible = PLATFORM_NODE_ELIGIBLE_TYPES.includes(type);
      expect({ type, schema: handler.nodeResultSchema !== undefined }).toEqual({ type, schema: eligible });
      expect({ type, persist: typeof handler.persistNodeResult === 'function' }).toEqual({ type, persist: eligible });
    }
  });

  it('forwards canDelete for exactly the veto types', () => {
    const vetoes = EXPECTED_JOB_TYPES.filter((type) => typeof platform.get(type)!.canDelete === 'function');
    expect(vetoes.sort()).toEqual([...EXPECTED_CAN_DELETE_TYPES].sort());
  });
});

describe('job type snapshot: the notification types RETRO-D3 retired', () => {
  it('keeps the three permanent strings dispatching on the platform registry, as server-only no-ops', async () => {
    expect([...RETIRED_NOTIFICATION_JOB_TYPES].sort()).toEqual([...EXPECTED_RETIRED_NOTIFICATION_TYPES].sort());
    const platform = new JobHandlerRegistry();
    new RetiredNotificationJobTypes(platform).onModuleInit();
    for (const type of EXPECTED_RETIRED_NOTIFICATION_TYPES) {
      const handler = platform.get(type)!;
      expect(handler).toBeDefined();
      expect(handler.nodeResultSchema).toBeUndefined();
      expect(handler.persistNodeResult).toBeUndefined();
      expect(handler.canDelete).toBeUndefined();
      await expect(handler.process({ id: 'job-1', type, payload: { broadcastId: 'b-1' } } as never)).resolves.toBeUndefined();
    }
    expect(platform.serverOnlyTypes().sort()).toEqual([...EXPECTED_RETIRED_NOTIFICATION_TYPES].sort());
  });
});

// RETRO-I1 (#562): the sharing slice's one job type. A platform slice type, so it
// is not in the app's handler fixture above; pinned here through the app's own
// `SHARING_JOBS` adapter, which is the path that registers it at boot.
describe('job type snapshot: the sharing slice (RETRO-I1)', () => {
  it('pins sharing.grants.prune, registered server-only through SharingJobsAdapter', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { GrantsPruneHandler, GRANTS_PRUNE_JOB_TYPE, resolveSharingModuleOptions } = require('@marinoscar/platform-api/sharing');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SharingJobsAdapter } = require('../../src/platform/sharing/sharing-jobs.adapter');

    expect(GRANTS_PRUNE_JOB_TYPE).toBe('sharing.grants.prune');

    const platform = new JobHandlerRegistry();
    const adapter = new SharingJobsAdapter(platform, {} as never, {} as never);
    const decorator = () => (() => undefined) as never;
    const options = resolveSharingModuleOptions({
      host: { access: { requirePermissions: decorator, requireAuthenticated: decorator } },
    });
    new GrantsPruneHandler({} as never, options, adapter).onModuleInit();

    expect(platform.types()).toEqual(['sharing.grants.prune']);
    expect(platform.serverOnlyTypes()).toEqual(['sharing.grants.prune']);
  });
});
