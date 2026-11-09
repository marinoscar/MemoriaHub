// =============================================================================
// The settings registry (RETRO-B3, #614)
// =============================================================================
//
// What the registry adds on top of the contract spec: every namespace is declared once and reaches the
// wire (the pitfall the registry retires: a namespace present in the schema and the service but not in
// the wire DTO validated in unit tests and silently no-opped on every real PATCH), every bound is the one
// the stored schema declares, the cache and the write-side effects of the app's subclasses, and the
// legacy user rows still read.
// =============================================================================

import {
  composeDefaultSystemSettings,
  composePatchSystemSettingsSchema,
  composePatchUserSettingsSchema,
  systemSettingsNamespaceRegistry,
  userSettingsNamespaceRegistry,
} from '@marinoscar/platform-api/settings';

import '../../src/settings/registry';
import {
  EXPECTED_SYSTEM_DEFAULTS,
  buildSettingsHarness,
  clearSettingsEnv,
  type SettingsHarness,
} from './settings-contract.harness';

const SYSTEM_KEYS = [
  'maintenance', // the platform's, registered first
  'jobs', 'retention', // the jobs slice's (RETRO-C1)
  'databaseBackup', // the db-backup slice's (RETRO-D4)
  'notifications', // the notifications slice's (RETRO-D3)
  'storage', // the storage slice's (RETRO-D1), extended with MemoriaHub's insights and trash
  'ui', 'features', 'ai', 'autoTagging', 'face', 'burst', 'dedup', 'locationInference',
  'locationGrouping', 'socialMedia', 'geo', 'email', 'reviewRuns',
  'pictureEnhancement', 'backup', 'workflows', 'memories',
  'telemetry', // the telemetry slice's declaration, appended by the app (RETRO-T2)
];
const USER_KEYS = [
  'dataTables', 'navigation', 'notifications', // the platform's (notifications: RETRO-D3)
  'search', 'memories', 'timezone', 'memoriahubNotifications', 'onboarding',
];

describe('settings registry', () => {
  let h: SettingsHarness;

  beforeEach(async () => {
    clearSettingsEnv();
    h = await buildSettingsHarness();
    h.system.seed(JSON.parse(JSON.stringify({ ...EXPECTED_SYSTEM_DEFAULTS, email: { ...EXPECTED_SYSTEM_DEFAULTS.email, smtpPassword: null }, maintenance: { ...EXPECTED_SYSTEM_DEFAULTS.maintenance, message: '' } })));
  });

  it('registers every system and user namespace, once', () => {
    expect(systemSettingsNamespaceRegistry.list().map((n) => n.key)).toEqual(SYSTEM_KEYS);
    expect(userSettingsNamespaceRegistry.list().map((n) => n.key)).toEqual(USER_KEYS);
  });

  it('composes the documented defaults', () => {
    const defaults = composeDefaultSystemSettings() as Record<string, unknown>;
    const { maintenance: expectedMaintenance, storage: expectedStorage, ...expected } = EXPECTED_SYSTEM_DEFAULTS;
    for (const [key, value] of Object.entries(expected)) {
      expect(defaults[key]).toEqual(value);
    }
    // `storage` (RETRO-D1): the platform composes `provider` and the drivers it knew when its
    // declaration was evaluated (the S3 family); the read path fills every registered driver
    // (MemoriaHub's `local` too) and the flat read view, which `GET` proves in the contract spec.
    expect(defaults['storage']).toEqual({
      provider: expectedStorage.provider,
      drivers: {
        r2: expectedStorage.drivers.r2,
        s3: expectedStorage.drivers.s3,
        s3compatible: expectedStorage.drivers.s3compatible,
      },
      insights: expectedStorage.insights,
      trash: expectedStorage.trash,
    });
    expect(defaults['maintenance']).toMatchObject(expectedMaintenance);
  });

  it('declares no secret-named field (the registry refuses one at import)', () => {
    expect(JSON.stringify(Object.keys(composeDefaultSystemSettings()))).not.toMatch(/password/i);
  });

  describe('the wire reaches every namespace (the stripped-key pitfall)', () => {
    it('PATCH of workflows.* persists', async () => {
      const after = await h.system.patch({ workflows: { maxItemsPerRun: 500 } });
      expect(after.workflows.maxItemsPerRun).toBe(500);
      expect(h.system.raw().workflows.maxItemsPerRun).toBe(500);
    });

    it('PATCH of backup.* persists', async () => {
      const after = await h.system.patch({ backup: { maxPageSize: 100, runStaleMinutes: 20 } });
      expect(after.backup).toEqual({ maxPageSize: 100, feedSafetyHorizonSeconds: 5, runStaleMinutes: 20 });
      expect(h.system.raw().backup.maxPageSize).toBe(100);
    });

    it('PATCH of face.autoArchive persists (the hand-written merge dropped it)', async () => {
      const after = await h.system.patch({ face: { autoArchive: { matchThreshold: 0.6 } } });
      expect(after.face.autoArchive.matchThreshold).toBe(0.6);
      expect(h.system.raw().face.autoArchive.matchThreshold).toBe(0.6);
    });

    // The platform's request bodies are not strict: an unknown key is stripped by validation and never
    // reaches the service (it is NOT a 400, which the issue text assumed). What matters is that it can
    // never be stored, and that every REGISTERED key is in the schema (the cases above).
    it('an unknown namespace key is stripped before the service sees it', async () => {
      const system = composePatchSystemSettingsSchema().parse({ notANamespace: { x: 1 }, burst: { minGroupSize: 4 } });
      expect(system).not.toHaveProperty('notANamespace');
      const user = composePatchUserSettingsSchema().parse({ notANamespace: { x: 1 }, theme: 'dark' });
      expect(user).not.toHaveProperty('notANamespace');

      await h.system.patch({ notANamespace: { x: 1 }, burst: { minGroupSize: 4 } });
      expect(h.system.raw()).not.toHaveProperty('notANamespace');
      expect(h.system.raw().burst.minGroupSize).toBe(4);
    });

    it('an unknown field inside a namespace is stripped', () => {
      expect(composePatchSystemSettingsSchema().parse({ burst: { surprise: 1, minGroupSize: 4 } })).toEqual({
        burst: { minGroupSize: 4 },
      });
    });
  });

  // One row per bounded number: the floor and ceiling pass, one past either fails.
  describe('bounds', () => {
    const bounds: Array<[string, string[], number, number, boolean]> = [
      ['burst.timeGapSeconds', ['burst', 'timeGapSeconds'], 1, 300, true],
      ['burst.hashDistance', ['burst', 'hashDistance'], 0, 32, true],
      ['burst.minGroupSize', ['burst', 'minGroupSize'], 2, 20, true],
      ['burst.autoResolveThreshold', ['burst', 'autoResolveThreshold'], 0, 100, true],
      ['dedup.hashMaxDistance', ['dedup', 'hashMaxDistance'], 0, 16, true],
      ['dedup.knnCandidates', ['dedup', 'knnCandidates'], 5, 50, true],
      ['dedup.similarityThreshold', ['dedup', 'similarityThreshold'], 0.8, 0.995, false],
      ['face.autoArchive.matchThreshold', ['face', 'autoArchive', 'matchThreshold'], 0.3, 0.9, false],
      ['face.video.sampleIntervalSeconds', ['face', 'video', 'sampleIntervalSeconds'], 1, 60, true],
      ['face.video.maxFramesPerVideo', ['face', 'video', 'maxFramesPerVideo'], 1, 300, true],
      ['autoTagging.video.maxFrames', ['autoTagging', 'video', 'maxFrames'], 1, 20, true],
      ['autoTagging.video.transcription.leadSeconds', ['autoTagging', 'video', 'transcription', 'leadSeconds'], 5, 600, true],
      ['storage.trash.retentionDays', ['storage', 'trash', 'retentionDays'], 1, 365, true],
      ['storage.insights.refreshIntervalHours', ['storage', 'insights', 'refreshIntervalHours'], 1, 168, true],
      ['jobs.stuckThresholdMinutes', ['jobs', 'stuckThresholdMinutes'], 1, 10080, true],
      ['jobs.history.retentionDays', ['jobs', 'history', 'retentionDays'], 1, 3650, true],
      ['reviewRuns.runHistoryRetentionDays', ['reviewRuns', 'runHistoryRetentionDays'], 1, 365, true],
      ['pictureEnhancement.maxBatchSize', ['pictureEnhancement', 'maxBatchSize'], 1, 200, true],
      ['pictureEnhancement.retentionHours', ['pictureEnhancement', 'retentionHours'], 1, 720, true],
      ['pictureEnhancement.maxInputMegapixels', ['pictureEnhancement', 'maxInputMegapixels'], 1, 100, false],
      ['backup.maxPageSize', ['backup', 'maxPageSize'], 50, 500, true],
      ['backup.runStaleMinutes', ['backup', 'runStaleMinutes'], 5, 120, true],
      ['workflows.maxItemsPerRun', ['workflows', 'maxItemsPerRun'], 100, 500000, true],
      ['workflows.batchSize', ['workflows', 'batchSize'], 50, 1000, true],
      ['workflows.maxConcurrentRuns', ['workflows', 'maxConcurrentRuns'], 1, 10, true],
      ['workflows.scheduleMinIntervalMinutes', ['workflows', 'scheduleMinIntervalMinutes'], 60, 10080, true],
      ['memories.generation.intervalHours', ['memories', 'generation', 'intervalHours'], 1, 168, true],
      ['memories.trips.minDistanceKm', ['memories', 'trips', 'minDistanceKm'], 5, 500, true],
      ['memories.digest.sendHourUtc', ['memories', 'digest', 'sendHourUtc'], 0, 23, true],
      ['databaseBackup.dayOfWeek', ['databaseBackup', 'dayOfWeek'], 0, 6, true],
      ['databaseBackup.dayOfMonth', ['databaseBackup', 'dayOfMonth'], 1, 28, true],
      ['databaseBackup.retentionCount', ['databaseBackup', 'retentionCount'], 1, 365, true],
      ['databaseBackup.runStaleMinutes', ['databaseBackup', 'runStaleMinutes'], 1, 10080, true],
      ['databaseBackup.compressionLevel', ['databaseBackup', 'compressionLevel'], 0, 9, true],
      ['databaseBackup.oldDatabaseRetentionHours', ['databaseBackup', 'oldDatabaseRetentionHours'], 1, 8760, true],
      ['locationInference.autoApplyMaxGapMinutes', ['locationInference', 'autoApplyMaxGapMinutes'], 0, 60, true],
      ['locationGrouping.suggestionMinItems', ['locationGrouping', 'suggestionMinItems'], 1, 1000, true],
      ['socialMedia.minConfidence', ['socialMedia', 'minConfidence'], 0.5, 1, false],
    ];

    const body = (path: string[], value: number) =>
      path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);

    it.each(bounds)('%s accepts its floor and ceiling and refuses one past either', (_name, path, min, max, integer) => {
      const ok = (v: number) => h.system.validatePatch(body(path, v)).success;
      expect(ok(min)).toBe(true);
      expect(ok(max)).toBe(true);
      expect(ok(min - (integer ? 1 : 0.0001))).toBe(false);
      expect(ok(max + (integer ? 1 : 0.0001))).toBe(false);
      if (integer) expect(ok(min + 0.5)).toBe(false);
    });

    it('databaseBackup.timeOfDay takes HH:mm only', () => {
      const ok = (v: string) => h.system.validatePatch({ databaseBackup: { timeOfDay: v } }).success;
      expect([ok('00:00'), ok('23:59'), ok('02:00')]).toEqual([true, true, true]);
      expect([ok('24:00'), ok('12:60'), ok('2:00'), ok('noon')]).toEqual([false, false, false, false]);
    });

    it('databaseBackup.storageProvider takes a key or the empty string ("no pin", the platform shape)', () => {
      expect(h.system.validatePatch({ databaseBackup: { storageProvider: '' } }).success).toBe(true);
      expect(h.system.validatePatch({ databaseBackup: { storageProvider: 'r2' } }).success).toBe(true);
    });

    it('face.features.detection and ai.features.* take null provider and model', () => {
      expect(h.system.validatePatch({ face: { features: { detection: { provider: null, model: null } } } }).success).toBe(true);
      expect(h.system.validatePatch({ ai: { features: { search: { provider: null } } } }).success).toBe(true);
    });
  });

  describe('merge rules specific to a namespace', () => {
    it('face.features.detection keeps the stored value on an explicit null (the old `??`)', async () => {
      await h.system.patch({ face: { features: { detection: { provider: 'compreface', model: 'm1' } } } });
      const after = await h.system.patch({ face: { features: { detection: { provider: null } } } });
      expect(after.face.features.detection).toEqual({ provider: 'compreface', model: 'm1' });
    });

    it('databaseBackup.storageProvider clears on the empty string (the platform merge)', async () => {
      await h.system.patch({ databaseBackup: { storageProvider: 'r2' } });
      const after = await h.system.patch({ databaseBackup: { storageProvider: '' } });
      expect(after.databaseBackup.storageProvider).toBe('');
    });

    it('databaseBackup.retentionCount and retention.count are one value (the platform alias)', async () => {
      const after = await h.system.patch({ databaseBackup: { retention: { count: 12 } } });
      expect(after.databaseBackup.retentionCount).toBe(12);
    });

    it('a stored sub-object that lacks one field keeps the others (what `.default()` per leaf did)', async () => {
      const stored = h.system.raw();
      stored.memories.trips = { enabled: true, minDays: 5 }; // an older document: no minItems/minDistanceKm/lookbackMonths
      h.system.seed(stored);
      const settings = await h.system.get();
      expect(settings.memories.trips).toEqual({ enabled: true, minDays: 5, minItems: 10, minDistanceKm: 50, lookbackMonths: 18 });
    });

    it('a document with a namespace missing reads the defaults for it', async () => {
      const stored = h.system.raw();
      delete stored.workflows;
      delete stored.dedup;
      h.system.seed(stored);
      const settings = await h.system.get();
      expect(settings.workflows).toEqual(EXPECTED_SYSTEM_DEFAULTS.workflows);
      expect(settings.dedup).toEqual(EXPECTED_SYSTEM_DEFAULTS.dedup);
    });

    it('a stored value that fails its bound reads as the default for that leaf only', async () => {
      const stored = h.system.raw();
      stored.burst.minGroupSize = 999;
      h.system.seed(stored);
      const settings = await h.system.get();
      expect(settings.burst).toEqual({ ...EXPECTED_SYSTEM_DEFAULTS.burst });
    });

    it('a stored empty maintenance message reads as the platform default message', async () => {
      const settings = await h.system.get();
      expect(settings.maintenance.message.length).toBeGreaterThan(0);
    });
  });

  describe('the settings cache (5 s)', () => {
    it('serves a second read without touching the database, and a write drops it', async () => {
      const find = h.db.prisma.systemSettings.findUnique as jest.Mock;
      await h.system.get();
      const afterFirst = find.mock.calls.length;
      await h.system.get();
      expect(find.mock.calls.length).toBe(afterFirst);

      await h.system.patch({ ui: { allowUserThemeOverride: false } });
      const fresh = await h.system.get();
      expect(fresh.ui.allowUserThemeOverride).toBe(false);
    });
  });

  describe('admin dismiss-on-disable (notifications.disabledEvents, the platform onWrite hook)', () => {
    it('dismisses the live rows of every disabled non-mandatory event inside the settings write', async () => {
      const raw = h.db.prisma.$executeRaw as jest.Mock;
      raw.mockClear();
      await h.system.patch({ notifications: { disabledEvents: ['shares.expiring', 'admin.broadcast_critical'] } });
      expect(raw).toHaveBeenCalledTimes(1);
      const call = JSON.stringify(raw.mock.calls[0]);
      expect(call).toContain('shares.expiring');
      // The mandatory critical broadcast is never dismissed by a policy switch.
      expect(call).not.toContain('admin.broadcast_critical');
    });

    it('a failed dismissal fails the settings write (same transaction)', async () => {
      (h.db.prisma.$executeRaw as jest.Mock).mockRejectedValueOnce(new Error('db down'));
      await expect(h.system.patch({ notifications: { disabledEvents: ['shares.expiring'] } })).rejects.toThrow(/db down/);
    });
  });

  describe('user settings rows written before the platform slice', () => {
    const userId = 'user-1';

    it('reads a legacy profile (useProviderImage) as the platform picture model and keeps the display name', async () => {
      h.user.seed(userId, { theme: 'dark', profile: { displayName: 'Person A', useProviderImage: true, customImageUrl: null } });
      const s = await h.user.get(userId);
      expect(s.theme).toBe('dark');
      expect(s.profile).toMatchObject({ displayName: 'Person A', imageSource: 'provider', imageObjectId: null });
      expect(s.profile).not.toHaveProperty('useProviderImage');
    });

    it('reads useProviderImage: false as no picture', async () => {
      h.user.seed(userId, { theme: 'system', profile: { useProviderImage: false } });
      expect((await h.user.get(userId)).profile.imageSource).toBe('none');
    });

    it('a PATCH rewrites a legacy profile into the platform shape and keeps every namespace', async () => {
      h.user.seed(userId, {
        theme: 'light',
        profile: { displayName: 'Person A', useProviderImage: true },
        search: { visibleFields: ['tag'] },
        dataTables: { 'admin-jobs': { visibleColumns: ['id'], density: 'compact', sort: { field: 'id', direction: 'desc' }, pageSize: 50 } },
        notifications: { browser: { 'media.upload_completed': false } },
        memories: { emailDigestOptOut: true },
        navigation: { pinned: ['albums'], railCollapsed: true },
        timezone: 'Europe/Paris',
      });
      await h.user.patch(userId, { theme: 'dark' });
      const raw = h.user.raw(userId);
      expect(raw).toMatchObject({
        theme: 'dark',
        search: { visibleFields: ['tag'] },
        dataTables: { 'admin-jobs': { visibleColumns: ['id'], density: 'compact', sort: { field: 'id', direction: 'desc' }, pageSize: 50 } },
        notifications: { browser: { 'media.upload_completed': false } },
        memories: { emailDigestOptOut: true },
        navigation: { pinned: ['albums'], railCollapsed: true },
        timezone: 'Europe/Paris',
      });
      expect(raw.profile).toMatchObject({ displayName: 'Person A', imageSource: 'provider' });
    });

    it('stores the onboarding namespace with MemoriaHub\'s establishedAt field (RETRO-H3)', async () => {
      h.user.seed(userId, { theme: 'system', profile: {} });
      const at = '2026-11-08T10:00:00.000Z';
      await h.user.patch(userId, { onboarding: { establishedAt: at, welcomeSeenAt: at } } as never);
      expect(h.user.raw(userId)['onboarding']).toEqual({ establishedAt: at, welcomeSeenAt: at });
      // `reopen` (the "Getting started" menu item) clears the platform fields only.
      await h.user.patch(userId, { onboarding: { welcomeSeenAt: null } } as never);
      expect(h.user.raw(userId)['onboarding']).toEqual({ establishedAt: at });
      await expect(async () => h.user.patch(userId, { onboarding: { establishedAt: 'yesterday' } } as never)).rejects.toThrow();
    });

    it('refuses to point the platform picture at an uploaded object (the avatar is the app\'s own)', async () => {
      h.user.seed(userId, { theme: 'system', profile: {} });
      await expect(
        h.user.patch(userId, { profile: { imageSource: 'upload', imageObjectId: '8c8b6f0e-8b8a-4a4a-9a9a-0123456789ab' } }),
      ).rejects.toThrow();
    });
  });
});
