// =============================================================================
// MemoriaHub's bindings of the telemetry slice's six host ports (RETRO-T2, #625)
// =============================================================================
//
// Each adapter is checked against its contract: the parity block compares every
// adapter with the platform's own stub of the same port
// (`createStubTelemetryPorts`), so a port method this app forgot to bind fails
// here instead of at the first request that needs it.
// =============================================================================

import { Test } from '@nestjs/testing';
import { APP_SLUG } from '@app/shared';
import { AUDIT_SINK } from '@marinoscar/platform-api/core';
import { AiError } from '@marinoscar/platform-api/ai';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import {
  DEFAULT_VERDICT_THRESHOLDS,
  TELEMETRY_AI,
  TELEMETRY_APP_INFO,
  TELEMETRY_AUDIT_SINK,
  TELEMETRY_CREDENTIAL_STORE,
  TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE,
  TELEMETRY_JOBS,
  TELEMETRY_SETTINGS_DEFAULTS,
  TELEMETRY_SETTINGS_STORE,
  resolveVerdictThresholds,
} from '@marinoscar/platform-api/telemetry';
import { createStubTelemetryPorts } from '@marinoscar/platform-api/telemetry/testing';
import { z } from 'zod';

import { APP_METRIC_GROUPS } from '../../src/app-registrations/telemetry';
import {
  MEMORIAHUB_CREDENTIAL_PURPOSE_DEFS,
  TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE_DEF,
} from '../../src/platform/credentials/credential-purposes.manifest';
import { MEMORIAHUB_VERDICT_THRESHOLDS } from '../../src/platform/telemetry/memoriahub-verdict-thresholds';
import {
  TELEMETRY_ASSISTANT_DISABLED_MESSAGE,
  TelemetryAiDisabledAdapter,
} from '../../src/platform/telemetry/telemetry-ai.adapter';
import { TelemetryAppInfoAdapter } from '../../src/platform/telemetry/telemetry-app-info.adapter';
import { TelemetryCredentialsAdapter } from '../../src/platform/telemetry/telemetry-credentials.adapter';
import { TelemetryHostModule } from '../../src/platform/telemetry/telemetry-host.module';
import { TelemetryJobsAdapter } from '../../src/platform/telemetry/telemetry-jobs.adapter';
import {
  TELEMETRY_OWNED_ROW_KEYS,
  TelemetrySettingsStoreAdapter,
} from '../../src/platform/telemetry/telemetry-settings-store.adapter';
import { TELEMETRY_SYSTEM_SETTINGS } from '../../src/platform/telemetry/telemetry.system-settings';

const UPDATED = new Date('2026-11-01T00:00:00Z');

describe('TelemetryHostModule', () => {
  it('binds every telemetry port, the assistant to the disabled stub, and exports each token', () => {
    const providers = Reflect.getMetadata('providers', TelemetryHostModule);
    const exported = Reflect.getMetadata('exports', TelemetryHostModule);

    expect(providers).toEqual([
      { provide: TELEMETRY_AUDIT_SINK, useExisting: AUDIT_SINK },
      { provide: TELEMETRY_SETTINGS_STORE, useClass: TelemetrySettingsStoreAdapter },
      { provide: TELEMETRY_CREDENTIAL_STORE, useClass: TelemetryCredentialsAdapter },
      { provide: TELEMETRY_JOBS, useClass: TelemetryJobsAdapter },
      { provide: TELEMETRY_AI, useClass: TelemetryAiDisabledAdapter },
      { provide: TELEMETRY_APP_INFO, useClass: TelemetryAppInfoAdapter },
    ]);
    expect(exported).toEqual([
      TELEMETRY_AUDIT_SINK,
      TELEMETRY_SETTINGS_STORE,
      TELEMETRY_CREDENTIAL_STORE,
      TELEMETRY_JOBS,
      TELEMETRY_AI,
      TELEMETRY_APP_INFO,
    ]);
  });
});

describe('port parity with the platform stubs (createStubTelemetryPorts)', () => {
  const methodsOf = (value: object): string[] => {
    const names = new Set<string>();
    for (let proto = value; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name !== 'constructor' && typeof (value as Record<string, unknown>)[name] === 'function') names.add(name);
      }
    }
    return [...names].sort();
  };

  it('each MemoriaHub adapter implements every method the stub of its port has', async () => {
    const { module } = createStubTelemetryPorts();
    const ref = await Test.createTestingModule({ imports: [module] }).compile();
    const pairs: [symbol, object][] = [
      [TELEMETRY_SETTINGS_STORE, new TelemetrySettingsStoreAdapter({} as never, {} as never, {} as never)],
      [TELEMETRY_CREDENTIAL_STORE, new TelemetryCredentialsAdapter({} as never)],
      [TELEMETRY_JOBS, new TelemetryJobsAdapter({} as never, {} as never, {} as never)],
      [TELEMETRY_AI, new TelemetryAiDisabledAdapter()],
      [TELEMETRY_APP_INFO, new TelemetryAppInfoAdapter()],
    ];
    for (const [token, adapter] of pairs) {
      const stub = ref.get(token) as object;
      expect(methodsOf(stub).length).toBeGreaterThan(0);
      const missing = methodsOf(stub).filter((name) => !methodsOf(adapter).includes(name));
      expect({ port: token.description, missing }).toEqual({ port: token.description, missing: [] });
    }
    await ref.close();
  });
});

describe('TelemetrySettingsStoreAdapter (TELEMETRY_SETTINGS_STORE)', () => {
  function setup() {
    const settings = {
      getNamespace: jest.fn().mockResolvedValue({ enabled: true }),
      patchSettings: jest.fn().mockResolvedValue({}),
      readNamespaceValue: jest.fn(async (key: string) => {
        const values: Record<string, unknown> = {
          ai: { enabled: true },
          maintenance: { enabled: false },
          databaseBackup: { enabled: true },
          notifications: { browserEnabled: true },
        };
        return values[key];
      }),
    };
    const rows = { write: jest.fn().mockResolvedValue({}) };
    const prisma = {
      systemSettings: {
        findUnique: jest.fn().mockResolvedValue({
          value: { mode: 'automatic' },
          version: 4,
          updatedAt: UPDATED,
          updatedByUser: { id: 'u1', email: 'person-a@example.test' },
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const store = new TelemetrySettingsStoreAdapter(settings as never, rows as never, prisma as never);
    return { store, settings, rows, prisma };
  }

  it('reads the namespace and replaces it through patchSettings (validation, If-Match, audit)', async () => {
    const { store, settings } = setup();

    await expect(store.getTelemetryPolicy()).resolves.toEqual({ enabled: true });
    expect(settings.getNamespace).toHaveBeenCalledWith('telemetry');
    await store.replaceTelemetryPolicy({ enabled: false } as never, 'u1', 3);
    expect(settings.patchSettings).toHaveBeenCalledWith({ telemetry: { enabled: false } }, 'u1', 3);
  });

  it("reads the global row's provenance without creating it", async () => {
    const { store, prisma } = setup();

    await expect(store.readPolicyProvenance()).resolves.toEqual({
      version: 4,
      updatedAt: UPDATED,
      updatedBy: { id: 'u1', email: 'person-a@example.test' },
    });
    expect(prisma.systemSettings.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'global' } }));
    prisma.systemSettings.findUnique.mockResolvedValue(null);
    await expect(store.readPolicyProvenance()).resolves.toBeNull();
  });

  it('reads, writes (through the row store) and deletes the telemetry_connection row', async () => {
    const { store, prisma, rows } = setup();

    await expect(store.readRow('telemetry_connection')).resolves.toEqual({
      value: { mode: 'automatic' },
      version: 4,
      updatedAt: UPDATED,
      updatedBy: { id: 'u1', email: 'person-a@example.test' },
    });
    await store.writeRow('telemetry_connection', { mode: 'automatic' }, 'u1');
    expect(rows.write).toHaveBeenCalledWith(
      'telemetry_connection',
      { mode: 'automatic' },
      expect.objectContaining({ actorId: 'u1' }),
    );
    await store.deleteRow('telemetry_connection');
    expect(prisma.systemSettings.deleteMany).toHaveBeenCalledWith({ where: { key: 'telemetry_connection' } });
  });

  it('refuses every row telemetry does not own, before touching the database', async () => {
    const { store, prisma, rows } = setup();

    expect(TELEMETRY_OWNED_ROW_KEYS).toEqual(['telemetry_connection', 'telemetry_store']);
    await expect(store.readRow('global')).rejects.toThrow('may not access');
    await expect(store.writeRow('email', {}, 'u1')).rejects.toThrow('may not access');
    await expect(store.deleteRow('android_app')).rejects.toThrow('may not access');
    expect(prisma.systemSettings.findUnique).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
    expect(prisma.systemSettings.deleteMany).not.toHaveBeenCalled();
  });

  it('answers the five allowlisted feature flags from their namespaces (no nodes namespace here)', async () => {
    const { store } = setup();

    const flags = await Promise.all(
      (['ai', 'maintenanceMode', 'databaseBackup', 'browserNotifications', 'nodeJobSecretBroker'] as const).map(
        (flag) => store.readFeatureFlag(flag),
      ),
    );
    expect(flags).toEqual([true, false, true, true, false]);
  });
});

describe('TelemetryCredentialsAdapter (TELEMETRY_CREDENTIAL_STORE)', () => {
  it('passes through to CredentialsService and describes without the secret', async () => {
    const credentials = {
      getSecret: jest.fn().mockResolvedValue('s3cret'),
      setSecret: jest.fn().mockResolvedValue(undefined),
      deleteSecret: jest.fn().mockResolvedValue(undefined),
      describe: jest.fn().mockResolvedValue({
        purpose: 'telemetry_greptime',
        name: 'reader',
        hint: '…cret',
        label: 'Reader',
        updatedByUserId: 'u1',
        createdAt: UPDATED,
        updatedAt: UPDATED,
        ciphertext: 'never-copied',
      }),
    };
    const adapter = new TelemetryCredentialsAdapter(credentials as unknown as CredentialsService);

    await expect(adapter.getSecret('telemetry_greptime', 'reader')).resolves.toBe('s3cret');
    await adapter.setSecret('telemetry_greptime', 'admin', 'x', { label: 'Admin', updatedByUserId: 'u1' });
    await adapter.deleteSecret('telemetry_greptime', 'admin');
    const info = await adapter.describe('telemetry_greptime', 'reader');

    expect(credentials.setSecret).toHaveBeenCalledWith('telemetry_greptime', 'admin', 'x', {
      label: 'Admin',
      updatedByUserId: 'u1',
    });
    expect(credentials.deleteSecret).toHaveBeenCalledWith('telemetry_greptime', 'admin');
    expect(info).toEqual({
      purpose: 'telemetry_greptime',
      name: 'reader',
      hint: '…cret',
      label: 'Reader',
      updatedByUserId: 'u1',
      createdAt: UPDATED,
      updatedAt: UPDATED,
    });
    credentials.describe.mockResolvedValue(null);
    await expect(adapter.describe('telemetry_greptime', 'admin')).resolves.toBeNull();
  });

  it('the telemetry_greptime purpose is registered for the system tier, owned by the telemetry slice', () => {
    expect(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE).toBe('telemetry_greptime');
    expect(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE_DEF).toEqual(
      expect.objectContaining({ purpose: 'telemetry_greptime', owner: 'telemetry', tiers: ['system'] }),
    );
    expect(MEMORIAHUB_CREDENTIAL_PURPOSE_DEFS).toContain(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE_DEF);
  });
});

describe('TelemetryJobsAdapter (TELEMETRY_JOBS)', () => {
  function setup() {
    const registry = { register: jest.fn() };
    const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'j1', status: 'pending' }) };
    const prisma = {
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'j1',
          type: 'telemetry.retention.apply',
          status: 'succeeded',
          payload: { days: 14 },
          createdAt: UPDATED,
          finishedAt: UPDATED,
          lastError: null,
          orgId: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    return { adapter: new TelemetryJobsAdapter(registry as never, jobs as never, prisma as never), registry, jobs, prisma };
  }

  it('enqueues a system job (orgId null) and reports its id and status', async () => {
    const { adapter, jobs } = setup();

    await expect(
      adapter.enqueue({ type: 'telemetry.retention.apply', reason: 'rerun', payload: { days: 14 } }),
    ).resolves.toEqual({ id: 'j1', status: 'pending' });
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'telemetry.retention.apply',
      reason: 'rerun',
      payload: { days: 14 },
      orgId: null,
    });
  });

  it('registers a handler on the platform registry and reads the latest job of a type', async () => {
    const { adapter, registry, prisma } = setup();
    const handler = { type: 'telemetry.retention.apply', process: jest.fn() };

    adapter.registerHandler(handler);
    expect(registry.register).toHaveBeenCalledWith(handler);
    await expect(adapter.findLatest('telemetry.retention.apply')).resolves.toEqual({
      id: 'j1',
      type: 'telemetry.retention.apply',
      status: 'succeeded',
      payload: { days: 14 },
      createdAt: UPDATED,
      finishedAt: UPDATED,
      lastError: null,
    });
    expect(prisma.job.findFirst).toHaveBeenCalledWith({
      where: { type: 'telemetry.retention.apply' },
      orderBy: { createdAt: 'desc' },
    });
    await adapter.updatePayload('j1', { days: 7 });
    expect(prisma.job.update).toHaveBeenCalledWith({ where: { id: 'j1' }, data: { payload: { days: 7 } } });
  });
});

describe('TelemetryAiDisabledAdapter (TELEMETRY_AI, PLATFORM-ADOPTION-SHIM until RETRO-E4)', () => {
  it('assertEnabled refuses with the platform 403 AI_DISABLED, never a 500', async () => {
    const adapter = new TelemetryAiDisabledAdapter();
    const error = await adapter.assertEnabled().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ code: 'AI_DISABLED', message: TELEMETRY_ASSISTANT_DISABLED_MESSAGE });
    expect((error as AiError).getStatus()).toBe(403);
    expect(adapter.isAiError(error)).toBe(true);
    expect(adapter.isAiError(new Error('x'))).toBe(false);
  });

  it('forUser refuses too, and defineTool is pure', () => {
    const adapter = new TelemetryAiDisabledAdapter();

    expect(() => adapter.forUser('u1')).toThrow(AiError);
    expect(() =>
      adapter.defineTool({ name: 'list_tables', description: 'd', parameters: z.object({}), execute: () => 1 }),
    ).not.toThrow();
  });
});

describe('TelemetryAppInfoAdapter (TELEMETRY_APP_INFO)', () => {
  it('reports the app slug, the OpenTelemetry service name and the API version', () => {
    const info = new TelemetryAppInfoAdapter();

    expect(info.slug).toBe(APP_SLUG);
    expect(info.serviceName()).toBe(process.env.OTEL_SERVICE_NAME || `${APP_SLUG}-api`);
    expect(info.apiVersion()).toEqual(expect.any(String));
  });

  it('reads the deploy document without throwing when none was written', async () => {
    const previous = process.env.DEPLOY_INFO_PATH;
    process.env.DEPLOY_INFO_PATH = '/nonexistent/memoriahub-test/deploy-info.json';
    try {
      const result = await new TelemetryAppInfoAdapter().readDeployInfo();
      expect(result.document).toBeNull();
      expect(result.status).toEqual(expect.any(String));
    } finally {
      if (previous === undefined) delete process.env.DEPLOY_INFO_PATH;
      else process.env.DEPLOY_INFO_PATH = previous;
    }
  });
});

describe('the telemetry settings namespace and the dashboard options', () => {
  it('declares the platform schema, the OFF defaults and the platform merge', () => {
    expect(TELEMETRY_SYSTEM_SETTINGS.key).toBe('telemetry');
    expect(TELEMETRY_SYSTEM_SETTINGS.defaults).toEqual(TELEMETRY_SETTINGS_DEFAULTS);
    expect(TELEMETRY_SYSTEM_SETTINGS.defaults.enabled).toBe(false);
    expect(TELEMETRY_SYSTEM_SETTINGS.storedSchema.parse(TELEMETRY_SETTINGS_DEFAULTS)).toEqual(TELEMETRY_SETTINGS_DEFAULTS);
    const merged = TELEMETRY_SYSTEM_SETTINGS.merge!(TELEMETRY_SETTINGS_DEFAULTS, { enabled: true, retentionDays: 14 });
    expect(merged).toEqual({ ...TELEMETRY_SETTINGS_DEFAULTS, enabled: true, retentionDays: 14 });
    expect(TELEMETRY_SYSTEM_SETTINGS.patchSchema.parse({ query: { maxRows: 100 } })).toEqual({ query: { maxRows: 100 } });
  });

  it("MemoriaHub's verdict thresholds equal the platform defaults (RETRO-T3 kept them)", () => {
    expect(resolveVerdictThresholds(MEMORIAHUB_VERDICT_THRESHOLDS)).toEqual(DEFAULT_VERDICT_THRESHOLDS);
  });

  it("adds MemoriaHub's six metric groups (RETRO-T3), ordered after the platform's", () => {
    expect(APP_METRIC_GROUPS.map((group) => [group.id, group.order])).toEqual([
      ['media', 80],
      ['enrichment', 81],
      ['memories', 82],
      ['storage', 83],
      ['ai_spend', 84],
      ['fleet_mh', 86],
    ]);
  });
});
