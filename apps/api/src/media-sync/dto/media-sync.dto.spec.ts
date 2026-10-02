import { applyCommand, applyPatch, defaultConfig, readConfig } from '../media-sync-config';
import {
  checkinSchema,
  commandSchema,
  listReportsQuerySchema,
  listRunsQuerySchema,
  mediaSyncConfigSchema,
  registerDeviceSchema,
  updateConfigSchema,
  uploadDiagnosticsSchema,
} from './media-sync.dto';

const CIRCLE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const INSTALL = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';

const stats = {
  eligible: 1,
  uploaded: 0,
  deduplicated: 0,
  pending: 1,
  uploading: 0,
  failed: 0,
  blocked: 0,
  bytesPending: 10,
  bytesUploaded: 0,
};
const checkin = { appliedConfigVersion: 0, stats, permission: 'full', networkState: 'wifi', batteryOptimized: false };
const run = {
  trigger: 'content_trigger',
  status: 'ok',
  startedAt: '2026-10-02T10:00:00Z',
  finishedAt: '2026-10-02T10:01:00Z',
  filesUploaded: 1,
  bytesUploaded: 10,
  filesFailed: 0,
  filesDeduplicated: 0,
};
const folder = (bucketId: string) => ({ bucketId, name: `F${bucketId}`, relativePath: 'DCIM/', photoCount: 1, videoCount: 0, bytes: 1 });

describe('Media Sync schemas', () => {
  describe('register', () => {
    it('accepts the documented body and normalises the signing fingerprint', () => {
      const hex = 'ab'.repeat(32);
      const parsed = registerDeviceSchema.parse({
        installationId: INSTALL,
        name: 'Pixel 9',
        manufacturer: 'Google',
        model: 'Pixel 9',
        androidVersion: '15',
        sdkInt: 35,
        appVersion: '1.0.0',
        appVersionCode: 3,
        packageName: 'memoriahub.marin.cr',
        signingSha256: hex,
        timezone: 'America/Costa_Rica',
      });
      expect(parsed.signingSha256).toBe(Array(32).fill('AB').join(':'));
    });

    it('accepts the colon form in any case', () => {
      const colon = Array(32).fill('0f').join(':');
      expect(registerDeviceSchema.parse({ installationId: INSTALL, name: 'P', signingSha256: colon }).signingSha256).toBe(
        Array(32).fill('0F').join(':'),
      );
    });

    it.each([
      ['an unknown key', { extra: 1 }],
      ['a missing name', { name: undefined }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      ['a non-uuid installationId', { installationId: 'abc' }],
      ['a short fingerprint', { signingSha256: 'AB:CD' }],
      ['a package name with spaces', { packageName: 'not a package' }],
      ['an appVersion over 50 characters', { appVersion: '1'.repeat(51) }],
      ['an unknown time zone', { timezone: 'Mars/Olympus' }],
    ])('rejects %s', (_label, patch) => {
      expect(registerDeviceSchema.safeParse({ installationId: INSTALL, name: 'Pixel', ...patch }).success).toBe(false);
    });
  });

  describe('config PATCH', () => {
    it('accepts a partial update plus an inventory', () => {
      expect(
        updateConfigSchema.safeParse({ network: 'any', folders: [{ bucketId: '1', name: 'Camera' }], inventory: [folder('1')] })
          .success,
      ).toBe(true);
    });

    it.each([
      ['paused (commands only)', { paused: true }],
      ['a generation (commands only)', { syncNowGeneration: 5 }],
      ['an unknown network policy', { network: 'metered' }],
      ['a duplicated folder', { folders: [{ bucketId: '1', name: 'a' }, { bucketId: '1', name: 'b' }] }],
      ['more than 200 folders', { folders: Array.from({ length: 201 }, (_, i) => ({ bucketId: String(i), name: 'f' })) }],
      ['more than 500 inventory entries', { inventory: Array.from({ length: 501 }, (_, i) => folder(String(i))) }],
      ['a non-uuid target circle', { targetCircleId: 'circle' }],
    ])('rejects %s', (_label, body) => {
      expect(updateConfigSchema.safeParse(body).success).toBe(false);
    });
  });

  describe('commands', () => {
    it('accepts the four actions only', () => {
      for (const action of ['pause', 'resume', 'retry_failed', 'sync_now']) {
        expect(commandSchema.safeParse({ action }).success).toBe(true);
      }
      expect(commandSchema.safeParse({ action: 'reboot' }).success).toBe(false);
      expect(commandSchema.safeParse({ action: 'pause', extra: 1 }).success).toBe(false);
    });
  });

  describe('check-in', () => {
    it('accepts the minimal body and a full one', () => {
      expect(checkinSchema.safeParse(checkin).success).toBe(true);
      expect(
        checkinSchema.safeParse({
          ...checkin,
          inventory: [folder('1')],
          appVersion: '1.0.1',
          appVersionCode: 2,
          run: {
            ...run,
            errorCode: 'NETWORK_POLICY',
            perFolder: [{ bucketId: '1', uploaded: 1, failed: 0, deduplicated: 0 }],
            failedSample: [{ name: 'a.jpg', relativePath: 'DCIM/', sizeBytes: 1, attempts: 2, lastError: 'boom' }],
          },
        }).success,
      ).toBe(true);
    });

    it.each([
      ['an unknown top-level key', { ...checkin, config: {} }],
      ['an extra stats key', { ...checkin, stats: { ...stats, perBucket: {} } }],
      ['a missing stats field', { ...checkin, stats: { ...stats, blocked: undefined } }],
      ['a negative count', { ...checkin, stats: { ...stats, failed: -1 } }],
      ['an unknown permission', { ...checkin, permission: 'some' }],
      ['an unknown network state', { ...checkin, networkState: 'ethernet' }],
      ['a run that finishes before it starts', { ...checkin, run: { ...run, finishedAt: '2026-10-02T09:00:00Z' } }],
      ['an unknown run status', { ...checkin, run: { ...run, status: 'great' } }],
      ['an unknown run key', { ...checkin, run: { ...run, windowFrom: '2026-01-01' } }],
      ['more than 50 failed samples', {
        ...checkin,
        run: { ...run, failedSample: Array.from({ length: 51 }, () => ({ name: 'a', sizeBytes: 1, attempts: 1 })) },
      }],
      ['a failed sample error over 500 characters', {
        ...checkin,
        run: { ...run, failedSample: [{ name: 'a', sizeBytes: 1, attempts: 1, lastError: 'x'.repeat(501) }] },
      }],
      ['more than 200 perFolder entries', {
        ...checkin,
        run: { ...run, perFolder: Array.from({ length: 201 }, (_, i) => ({ bucketId: String(i) })) },
      }],
      ['an error code over 64 characters', { ...checkin, run: { ...run, errorCode: 'E'.repeat(65) } }],
      ['an inventory over 500 entries', { ...checkin, inventory: Array.from({ length: 501 }, (_, i) => folder(String(i))) }],
    ])('rejects %s', (_label, body) => {
      expect(checkinSchema.safeParse(body).success).toBe(false);
    });
  });

  describe('diagnostics and queries', () => {
    it('caps the report at 256 KB serialized and the summary at 500 characters', () => {
      expect(uploadDiagnosticsSchema.safeParse({ report: { a: 'x'.repeat(1000) } }).success).toBe(true);
      expect(uploadDiagnosticsSchema.safeParse({ report: { a: 'x'.repeat(256 * 1024) } }).success).toBe(false);
      expect(uploadDiagnosticsSchema.safeParse({ summary: 'x'.repeat(501), report: {} }).success).toBe(false);
    });

    it('defaults and bounds the list limits', () => {
      expect(listRunsQuerySchema.parse({}).limit).toBe(50);
      expect(listRunsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
      expect(listReportsQuerySchema.parse({}).limit).toBe(5);
      expect(listReportsQuerySchema.safeParse({ limit: '21' }).success).toBe(false);
    });
  });
});

describe('Media Sync config helpers', () => {
  it('the default config is valid and syncs nothing', () => {
    const config = defaultConfig(CIRCLE);
    expect(mediaSyncConfigSchema.parse(config)).toEqual(config);
    expect(config.folders).toEqual([]);
    expect(config.network).toBe('wifi');
  });

  it('applyPatch reports only the keys whose value changed', () => {
    const { config, changedKeys } = applyPatch(defaultConfig(CIRCLE), { network: 'wifi', requireCharging: true });
    expect(changedKeys).toEqual(['requireCharging']);
    expect(config.requireCharging).toBe(true);
  });

  it('applyCommand never touches anything but its own field', () => {
    const base = defaultConfig(CIRCLE);
    expect(applyCommand(base, 'pause')).toEqual({ ...base, paused: true });
    expect(applyCommand({ ...base, paused: true }, 'resume')).toEqual(base);
    expect(applyCommand(base, 'retry_failed')).toEqual({ ...base, retryFailedGeneration: 1 });
    expect(applyCommand(base, 'sync_now')).toEqual({ ...base, syncNowGeneration: 1 });
  });

  it('readConfig keeps valid fields of a damaged row and defaults the rest', () => {
    const config = readConfig({ ...defaultConfig(CIRCLE), network: 'carrier-pigeon', futureField: 1 });
    expect(config.targetCircleId).toBe(CIRCLE);
    expect(config.network).toBe('wifi');
    expect(config).not.toHaveProperty('futureField');
  });
});
