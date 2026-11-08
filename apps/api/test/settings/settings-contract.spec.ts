// =============================================================================
// The settings contract (RETRO-B3, #614)
// =============================================================================
//
// What `/api/system-settings` and `/api/user-settings` DO for every MemoriaHub
// namespace: defaults, partial PATCH, the per-namespace merge rules, the
// absent-means-X rule of the user namespaces, validation bounds, the secret
// that never leaves the row, and the write-side effects (dismiss-on-disable,
// cache invalidation). It asserts MemoriaHub's own fields only, never what the
// platform adds around them, and it ran against the hand-written services
// before the platform settings slice replaced them: the same file must keep
// passing across that swap.
// =============================================================================

import {
  EXPECTED_SYSTEM_DEFAULTS,
  buildSettingsHarness,
  clearSettingsEnv,
  type SettingsHarness,
} from './settings-contract.harness';

const OLD_ENV = { ...process.env };

/** A stored `global` row as the seed (and the pre-B3 code) wrote it. */
function storedDefaults(): Record<string, unknown> {
  const stored = JSON.parse(JSON.stringify(EXPECTED_SYSTEM_DEFAULTS));
  stored.email.smtpPassword = null;
  stored.maintenance.message = '';
  return stored;
}

/** Everything of `value` the contract pins (drops fields the contract leaves open). */
function pick(settings: Record<string, any>, keys: readonly string[]): Record<string, any> {
  return Object.fromEntries(keys.map((k) => [k, settings[k]]));
}

describe('settings contract', () => {
  let h: SettingsHarness;

  beforeEach(async () => {
    clearSettingsEnv();
    h = await buildSettingsHarness();
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  // ---------------------------------------------------------------------------
  describe('system settings', () => {
    beforeEach(() => h.system.seed(storedDefaults()));

    const namespaces = Object.keys(EXPECTED_SYSTEM_DEFAULTS).filter((k) => k !== 'maintenance' && k !== 'email');

    it.each(namespaces)('GET reads the %s defaults', async (ns) => {
      const settings = await h.system.get();
      expect(settings[ns]).toEqual((EXPECTED_SYSTEM_DEFAULTS as any)[ns]);
    });

    it('GET reads the email and maintenance defaults without the secret', async () => {
      const settings = await h.system.get();
      expect(settings.email).toEqual(EXPECTED_SYSTEM_DEFAULTS.email);
      expect(settings.email).not.toHaveProperty('smtpPassword');
      expect(settings.maintenance).toMatchObject({
        enabled: false,
        allowAdmins: true,
        startedAt: null,
        startedById: null,
      });
    });

    it('GET carries the version and the audit fields', async () => {
      const settings = await h.system.get();
      expect(settings.version).toBe(1);
      expect(settings).toHaveProperty('updatedAt');
    });

    // One partial patch per namespace: the changed field moves, its siblings do not.
    const patches: Array<[string, Record<string, unknown>, (s: Record<string, any>) => unknown, unknown]> = [
      ['ui', { ui: { allowUserThemeOverride: false } }, (s) => s.ui.allowUserThemeOverride, false],
      ['autoTagging', { autoTagging: { video: { enabled: true } } }, (s) => s.autoTagging.video.enabled, true],
      ['face', { face: { video: { maxFramesPerVideo: 120 } } }, (s) => s.face.video.maxFramesPerVideo, 120],
      ['storage', { storage: { trash: { retentionDays: 7 } } }, (s) => s.storage.trash.retentionDays, 7],
      ['burst', { burst: { minGroupSize: 5 } }, (s) => s.burst.minGroupSize, 5],
      ['dedup', { dedup: { similarityThreshold: 0.9 } }, (s) => s.dedup.similarityThreshold, 0.9],
      ['locationInference', { locationInference: { maxGapMinutes: 60 } }, (s) => s.locationInference.maxGapMinutes, 60],
      ['locationGrouping', { locationGrouping: { maxRadiusKm: 80 } }, (s) => s.locationGrouping.maxRadiusKm, 80],
      ['socialMedia', { socialMedia: { ocrMaxFrames: 6 } }, (s) => s.socialMedia.ocrMaxFrames, 6],
      ['geo', { geo: { reverseProvider: 'nominatim' } }, (s) => s.geo.reverseProvider, 'nominatim'],
      ['email', { email: { fromName: 'Family' } }, (s) => s.email.fromName, 'Family'],
      ['jobs', { jobs: { history: { retentionDays: 14 } } }, (s) => s.jobs.history.retentionDays, 14],
      ['reviewRuns', { reviewRuns: { runHistoryRetentionDays: 10 } }, (s) => s.reviewRuns.runHistoryRetentionDays, 10],
      ['notifications', { notifications: { retentionDays: 90 } }, (s) => s.notifications.retentionDays, 90],
      ['pictureEnhancement', { pictureEnhancement: { maxBatchSize: 50 } }, (s) => s.pictureEnhancement.maxBatchSize, 50],
      ['memories', { memories: { trips: { minDays: 3 } } }, (s) => s.memories.trips.minDays, 3],
      ['databaseBackup', { databaseBackup: { retentionCount: 14 } }, (s) => s.databaseBackup.retentionCount, 14],
      ['maintenance', { maintenance: { allowAdmins: false } }, (s) => s.maintenance.allowAdmins, false],
    ];

    it.each(patches)('PATCH %s changes the named field and leaves its siblings', async (ns, body, read, expected) => {
      const before = await h.system.get();
      const after = await h.system.patch(body);
      expect(read(after)).toEqual(expected);
      // Every other namespace is untouched.
      for (const other of namespaces.filter((k) => k !== ns)) {
        expect(after[other]).toEqual(before[other]);
      }
    });

    it('PATCH of nested siblings keeps the untouched ones (workflows.triggers)', async () => {
      const after = await h.system.patch({ workflows: { triggers: { scheduled: false } } });
      expect(after.workflows.triggers).toEqual({ onEnrichment: true, scheduled: false });
      expect(after.workflows.maxItemsPerRun).toBe(10000);
    });

    it('PATCH of memories.digest keeps its sibling digest fields', async () => {
      const after = await h.system.patch({ memories: { digest: { frequency: 'daily' } } });
      expect(after.memories.digest).toEqual({
        enabled: true,
        frequency: 'daily',
        sendHourUtc: 8,
        imageTokenTtlDays: 30,
      });
    });

    it('PATCH of features merges the flag map key by key', async () => {
      await h.system.patch({ features: { workflows: true } });
      const after = await h.system.patch({ features: { memories: true } });
      expect(after.features).toEqual({ workflows: true, memories: true });
      const flipped = await h.system.patch({ features: { workflows: false } });
      expect(flipped.features).toEqual({ workflows: false, memories: true });
    });

    it('PATCH replaces an array wholesale (socialMedia.ocrLanguages, notifications.disabledTypes)', async () => {
      await h.system.patch({ socialMedia: { ocrLanguages: ['eng', 'spa'] } });
      const after = await h.system.patch({ socialMedia: { ocrLanguages: ['fra'] } });
      expect(after.socialMedia.ocrLanguages).toEqual(['fra']);

      await h.system.patch({ notifications: { disabledTypes: ['upload_completed', 'share_expiring'] } });
      const second = await h.system.patch({ notifications: { disabledTypes: ['share_expiring'] } });
      expect(second.notifications.disabledTypes).toEqual(['share_expiring']);
      const cleared = await h.system.patch({ notifications: { disabledTypes: [] } });
      expect(cleared.notifications.disabledTypes).toEqual([]);
    });

    it('an explicit null clears a nullable email field', async () => {
      await h.system.patch({ email: { provider: 'smtp', smtpHost: 'mail.example.test', sesRegion: 'eu-west-1' } });
      const after = await h.system.patch({ email: { provider: null, smtpHost: null } });
      expect(after.email.provider).toBeNull();
      expect(after.email.smtpHost).toBeNull();
      expect(after.email.sesRegion).toBe('eu-west-1');
    });

    it('a nullable object (ai.features.enhance) is set whole and cleared with null', async () => {
      const set = await h.system.patch({
        ai: { features: { enhance: { provider: 'openai', model: 'gpt-image-1' } } },
      });
      expect(set.ai.features.enhance).toEqual({ provider: 'openai', model: 'gpt-image-1' });
      const untouched = await h.system.patch({ ai: { features: { search: { provider: 'openai', model: 'm' } } } });
      expect(untouched.ai.features.enhance).toEqual({ provider: 'openai', model: 'gpt-image-1' });
      expect(untouched.ai.features.search).toEqual({ provider: 'openai', model: 'm' });
      const cleared = await h.system.patch({ ai: { features: { enhance: null } } });
      expect(cleared.ai.features.enhance).toBeNull();
    });

    it('ai.features.memories and transcription follow the same set-whole/clear rule', async () => {
      await h.system.patch({
        ai: {
          features: {
            memories: { provider: 'anthropic', model: 'a' },
            transcription: { provider: 'openai', model: 'whisper-1' },
          },
        },
      });
      const after = await h.system.patch({ ai: { features: { memories: null } } });
      expect(after.ai.features.memories).toBeNull();
      expect(after.ai.features.transcription).toEqual({ provider: 'openai', model: 'whisper-1' });
    });

    it('an If-Match version that is stale is a conflict', async () => {
      await expect(h.system.patch({ ui: { allowUserThemeOverride: false } }, 99)).rejects.toThrow(/version mismatch/i);
    });

    it('every write bumps the version', async () => {
      const first = await h.system.patch({ ui: { allowUserThemeOverride: false } });
      const second = await h.system.patch({ ui: { allowUserThemeOverride: true } });
      expect(second.version).toBe(first.version + 1);
    });

    it.each<[string, unknown]>([
      ['burst.minGroupSize below the floor', { burst: { minGroupSize: 1 } }],
      ['dedup.similarityThreshold above the ceiling', { dedup: { similarityThreshold: 0.999 } }],
      ['jobs.history.retentionDays above 365', { jobs: { history: { retentionDays: 366 } } }],
      ['jobs.stuckThresholdMinutes above 120', { jobs: { stuckThresholdMinutes: 121 } }],
      ['socialMedia.ocrLanguages empty', { socialMedia: { ocrLanguages: [] } }],
      ['socialMedia.maxSizeBytes below 10 MB', { socialMedia: { maxSizeBytes: 9_999_999 } }],
      ['face.autoArchive.matchThreshold below 0.30', { face: { autoArchive: { matchThreshold: 0.2 } } }],
      ['geo.reverseProvider not an enum member', { geo: { reverseProvider: 'bing' } }],
      ['email.smtpPort 0', { email: { smtpPort: 0 } }],
      ['notifications.disabledTypes unknown type', { notifications: { disabledTypes: ['nope'] } }],
      ['pictureEnhancement.maxBatchSize above 200', { pictureEnhancement: { maxBatchSize: 201 } }],
      ['databaseBackup.timeOfDay not HH:mm', { databaseBackup: { timeOfDay: '25:00' } }],
      ['databaseBackup.dayOfMonth above 28', { databaseBackup: { dayOfMonth: 29 } }],
      ['memories.digest.frequency not an enum member', { memories: { digest: { frequency: 'hourly' } } }],
      ['workflows.maxItemsPerRun below 100', { workflows: { maxItemsPerRun: 99 } }],
      ['maintenance.message over 500 characters', { maintenance: { message: 'x'.repeat(501) } }],
      ['features with a non-boolean flag', { features: { workflows: 'yes' } }],
      ['locationGrouping.maxRadiusKm above 200', { locationGrouping: { maxRadiusKm: 201 } }],
    ])('rejects %s', (_name, body) => {
      expect(h.system.validatePatch(body).success).toBe(false);
    });

    describe('email.smtpPassword', () => {
      it('stays in the stored row across a PATCH of the namespace, and out of every response', async () => {
        const stored = storedDefaults() as Record<string, any>;
        stored.email.smtpPassword = 'v1:ciphertext';
        h.system.seed(stored);

        const after = await h.system.patch({ email: { fromName: 'Family', enabled: true } });
        expect(after.email).not.toHaveProperty('smtpPassword');
        expect(h.system.raw().email.smtpPassword).toBe('v1:ciphertext');
        expect(h.system.raw().email.fromName).toBe('Family');

        // ...and across a PATCH of another namespace.
        await h.system.patch({ ui: { allowUserThemeOverride: false } });
        expect(h.system.raw().email.smtpPassword).toBe('v1:ciphertext');
        expect(JSON.stringify(await h.system.get())).not.toContain('ciphertext');
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('user settings', () => {
    const userId = 'user-1';
    const legacyDefaults = () => ({ theme: 'system', profile: { useProviderImage: true } });

    beforeEach(() => h.user.seed(userId, legacyDefaults()));

    it('GET materialises no optional namespace', async () => {
      const s = await h.user.get(userId);
      expect(s.theme).toBe('system');
      for (const key of ['dataTables', 'notifications', 'memories', 'navigation', 'timezone', 'search']) {
        expect(s[key]).toBeUndefined();
      }
    });

    it('PATCH theme and profile.displayName', async () => {
      const s = await h.user.patch(userId, { theme: 'dark', profile: { displayName: 'Person A' } });
      expect(s.theme).toBe('dark');
      expect(s.profile.displayName).toBe('Person A');
      expect(h.db.users.get(userId)).toMatchObject({ displayName: 'Person A' });
    });

    it('an unrelated PATCH leaves an unrelated namespace stored as it was', async () => {
      h.user.seed(userId, { ...legacyDefaults(), memories: { emailDigestOptOut: true } });
      await h.user.patch(userId, { theme: 'light' });
      expect(h.user.raw(userId).memories).toEqual({ emailDigestOptOut: true });
    });

    it('rejects an unknown theme', () => {
      expect(h.user.validatePatch({ theme: 'neon' }).success).toBe(false);
    });

    describe('search', () => {
      it('is replaced wholesale', async () => {
        await h.user.patch(userId, { search: { visibleFields: ['tag', 'person'] } });
        const s = await h.user.patch(userId, { search: { visibleFields: ['date'] } });
        expect(s.search).toEqual({ visibleFields: ['date'] });
      });
    });

    describe('dataTables (per table id, one level deep)', () => {
      it('adds, replaces a whole entry, and leaves other ids alone', async () => {
        await h.user.patch(userId, { dataTables: { 'admin-jobs': { density: 'compact', pageSize: 50 } } });
        await h.user.patch(userId, { dataTables: { 'admin-users': { visibleColumns: ['email'] } } });
        const s = await h.user.patch(userId, { dataTables: { 'admin-jobs': { density: 'comfortable' } } });
        expect(s.dataTables['admin-jobs']).toMatchObject({ density: 'comfortable' });
        expect(s.dataTables['admin-jobs'].pageSize).toBeUndefined();
        expect(s.dataTables['admin-users']).toMatchObject({ visibleColumns: ['email'] });
      });

      it('null deletes an entry; an empty entry resets it to defaults; the last delete drops the namespace', async () => {
        await h.user.patch(userId, { dataTables: { a: { density: 'compact' }, b: { density: 'standard' } } });
        const s = await h.user.patch(userId, { dataTables: { a: null, b: {} } });
        expect(s.dataTables).toEqual({ b: {} });
        const gone = await h.user.patch(userId, { dataTables: { b: null } });
        expect(gone.dataTables ?? undefined).toBeUndefined();
      });

      it('never materialises a default inside an entry', async () => {
        const s = await h.user.patch(userId, { dataTables: { t: { density: 'compact' } } });
        expect(s.dataTables.t).toEqual({ density: 'compact' });
      });

      it('rejects a table id that is not lowercase, and a bad density', () => {
        expect(h.user.validatePatch({ dataTables: { 'Bad Id': {} } }).success).toBe(false);
        expect(h.user.validatePatch({ dataTables: { t: { density: 'huge' } } }).success).toBe(false);
        expect(h.user.validatePatch({ dataTables: { t: { pageSize: 501 } } }).success).toBe(false);
      });

      it('caps the namespace at 40 table ids after the merge', async () => {
        const forty = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`t${i}`, { density: 'compact' }]));
        await h.user.patch(userId, { dataTables: forty });
        await expect(h.user.patch(userId, { dataTables: { extra: { density: 'compact' } } })).rejects.toThrow(
          /at most 40|Too many/i,
        );
      });
    });

    describe('notifications (absent means enabled)', () => {
      it('merges per type id, and null resets a type to its default', async () => {
        await h.user.patch(userId, { notifications: { types: { upload_completed: false } } });
        const s = await h.user.patch(userId, { notifications: { types: { share_expiring: false } } });
        expect(s.notifications.types).toEqual({ upload_completed: false, share_expiring: false });
        const reset = await h.user.patch(userId, { notifications: { types: { upload_completed: null } } });
        expect(reset.notifications.types).toEqual({ share_expiring: false });
      });

      it('merges the top-level fields and the push block field-wise', async () => {
        await h.user.patch(userId, { notifications: { enabled: false, workflowMicroRuns: true } });
        await h.user.patch(userId, { notifications: { push: { enabled: false, types: { enrichment_failed: false } } } });
        const s = await h.user.patch(userId, { notifications: { push: { types: { enrichment_failed: null } } } });
        expect(s.notifications).toEqual({ enabled: false, workflowMicroRuns: true, push: { enabled: false } });
        const cleared = await h.user.patch(userId, { notifications: { push: null } });
        expect(cleared.notifications).toEqual({ enabled: false, workflowMicroRuns: true });
      });

      it('null clears the whole namespace back to absent', async () => {
        await h.user.patch(userId, { notifications: { enabled: false } });
        const s = await h.user.patch(userId, { notifications: null });
        expect(s.notifications ?? undefined).toBeUndefined();
        expect(h.user.raw(userId).notifications).toBeUndefined();
      });

      it('rejects an unknown type and an unknown key', () => {
        expect(h.user.validatePatch({ notifications: { types: { nope: false } } }).success).toBe(false);
        expect(h.user.validatePatch({ notifications: { surprise: true } }).success).toBe(false);
      });

      it('disabling a type dismisses its live rows and invalidates the preference cache; re-enabling dismisses nothing', async () => {
        await h.user.patch(userId, { notifications: { types: { upload_completed: false } } });
        expect(h.notifications.dismissTypesForUser).toHaveBeenCalledWith(
          userId,
          expect.arrayContaining(['upload_completed']),
          expect.anything(),
        );
        expect(h.notifications.invalidatePreferences).toHaveBeenCalledWith(userId);

        h.notifications.dismissTypesForUser.mockClear();
        await h.user.patch(userId, { notifications: { types: { upload_completed: null } } });
        expect(h.notifications.dismissTypesForUser).not.toHaveBeenCalled();
        expect(h.notifications.invalidatePreferences).toHaveBeenCalledWith(userId);
      });

      it('turning every notification off dismisses every type', async () => {
        await h.user.patch(userId, { notifications: { enabled: false } });
        const [, types] = h.notifications.dismissTypesForUser.mock.calls[0];
        expect(types.length).toBeGreaterThan(5);
      });
    });

    describe('memories (field-wise, absent means no preference)', () => {
      const personId = '8c8b6f0e-8b8a-4a4a-9a9a-0123456789ab';

      it('replaces a listed field, keeps an unlisted one, null deletes a field', async () => {
        await h.user.patch(userId, { memories: { hiddenPersonIds: [personId], emailDigestOptOut: true } });
        const s = await h.user.patch(userId, { memories: { emailDigestOptOut: false } });
        expect(s.memories).toEqual({ hiddenPersonIds: [personId], emailDigestOptOut: false });
        const d = await h.user.patch(userId, { memories: { hiddenPersonIds: null } });
        expect(d.memories).toEqual({ emailDigestOptOut: false });
      });

      it('null clears the namespace; emptying the last field drops it', async () => {
        await h.user.patch(userId, { memories: { emailDigestOptOut: true } });
        const emptied = await h.user.patch(userId, { memories: { emailDigestOptOut: null } });
        expect(emptied.memories ?? undefined).toBeUndefined();
        await h.user.patch(userId, { memories: { emailDigestOptOut: true } });
        const cleared = await h.user.patch(userId, { memories: null });
        expect(cleared.memories ?? undefined).toBeUndefined();
      });

      it('validates date ranges and caps', () => {
        expect(h.user.validatePatch({ memories: { hiddenDateRanges: [{ from: '2026-02-31', to: '2026-03-01' }] } }).success).toBe(false);
        expect(h.user.validatePatch({ memories: { hiddenDateRanges: [{ from: '2026-03-02', to: '2026-03-01' }] } }).success).toBe(false);
        expect(h.user.validatePatch({ memories: { hiddenDateRanges: [{ from: '2026-03-01', to: '2026-03-02' }] } }).success).toBe(true);
        expect(h.user.validatePatch({ memories: { hiddenPersonIds: ['not-a-uuid'] } }).success).toBe(false);
      });
    });

    describe('navigation (field-wise)', () => {
      it('merges pinned and railCollapsed independently; null deletes a field', async () => {
        await h.user.patch(userId, { navigation: { pinned: ['albums', 'people'], railCollapsed: true } });
        const s = await h.user.patch(userId, { navigation: { railCollapsed: false } });
        expect(s.navigation).toEqual({ pinned: ['albums', 'people'], railCollapsed: false });
        const d = await h.user.patch(userId, { navigation: { pinned: null } });
        expect(d.navigation).toEqual({ railCollapsed: false });
      });

      it('rejects an unknown destination and more than six pins', () => {
        expect(h.user.validatePatch({ navigation: { pinned: ['nowhere'] } }).success).toBe(false);
        expect(
          h.user.validatePatch({
            navigation: { pinned: ['albums', 'people', 'places', 'memories', 'map', 'favorites', 'archive'] },
          }).success,
        ).toBe(false);
      });

      it('drops a stored pin this release no longer knows, instead of failing every later PATCH', async () => {
        h.user.seed(userId, { ...legacyDefaults(), navigation: { pinned: ['albums', 'retired-destination'] } });
        expect((await h.user.get(userId)).navigation.pinned).toEqual(['albums']);
        const s = await h.user.patch(userId, { theme: 'dark' });
        expect(s.theme).toBe('dark');
        expect(h.user.raw(userId).navigation.pinned).toEqual(['albums']);
      });
    });

    describe('timezone (a scalar; absent is not UTC)', () => {
      it('absent until chosen, replaced by a value, cleared by null', async () => {
        expect((await h.user.get(userId)).timezone).toBeUndefined();
        const set = await h.user.patch(userId, { timezone: 'Europe/London' });
        expect(set.timezone).toBe('Europe/London');
        const utc = await h.user.patch(userId, { timezone: 'UTC' });
        expect(utc.timezone).toBe('UTC');
        const cleared = await h.user.patch(userId, { timezone: null });
        expect(cleared.timezone ?? undefined).toBeUndefined();
        expect(h.user.raw(userId).timezone).toBeUndefined();
      });

      it('accepts a live alias the canonical list omits, rejects an unknown zone', () => {
        expect(h.user.validatePatch({ timezone: 'Asia/Kolkata' }).success).toBe(true);
        expect(h.user.validatePatch({ timezone: 'Mars/Olympus' }).success).toBe(false);
        expect(h.user.validatePatch({ timezone: '' }).success).toBe(false);
      });

      it('invalidates the zone cache on every write', async () => {
        await h.user.patch(userId, { timezone: 'Europe/Paris' });
        expect(h.timeZone.invalidate).toHaveBeenCalledWith(userId);
      });

      it('an unrelated PATCH keeps the stored zone', async () => {
        await h.user.patch(userId, { timezone: 'Europe/Paris' });
        await h.user.patch(userId, { theme: 'dark' });
        expect(h.user.raw(userId).timezone).toBe('Europe/Paris');
      });
    });

    it('pins the user-visible part of the response shape', async () => {
      const s = await h.user.patch(userId, { theme: 'dark' });
      expect(pick(s, ['theme'])).toEqual({ theme: 'dark' });
      expect(s.version).toBeGreaterThan(1);
      expect(s).toHaveProperty('updatedAt');
    });
  });
});
