/** services/mediaSync.ts + services/androidApp.ts (issue #515). */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  CONFIG_PENDING_MESSAGE,
  daysUntil,
  deviceStatusLines,
  listDevices,
  mediaSyncErrorReason,
  sendDeviceCommand,
  syncCounts,
  unknownFolderIds,
  updateDeviceConfig,
} from '../../services/mediaSync';
import { createDownloadLink, formatMegabytes, getLatestRelease } from '../../services/androidApp';
import { ApiError } from '../../services/api';
import { DEVICE_ID, makeDevice, makeRelease } from '../fixtures/mediaSync';

describe('syncCounts (counts math)', () => {
  it('synced = uploaded + deduplicated; missing = pending + uploading + failed + blocked', () => {
    const counts = syncCounts(makeDevice().stats);
    expect(counts).toEqual({
      synced: 100,
      missing: 24,
      failed: 6,
      blocked: 2,
      eligible: 124,
      bytesPending: 52_428_800,
      percent: 81,
    });
  });

  it('has no percentage when nothing is eligible, and null without stats', () => {
    expect(
      syncCounts({ eligible: 0, uploaded: 0, deduplicated: 0, pending: 0, uploading: 0, failed: 0, blocked: 0, bytesPending: 0, bytesUploaded: 0 })
        ?.percent,
    ).toBeNull();
    expect(syncCounts(null)).toBeNull();
  });
});

describe('deviceStatusLines', () => {
  it('is empty for a healthy, applied device', () => {
    expect(deviceStatusLines(makeDevice())).toEqual([]);
  });

  it('shows the configPending banner', () => {
    const lines = deviceStatusLines(makeDevice({ configPending: true, appliedConfigVersion: 2 }));
    expect(lines.map((l) => l.key)).toEqual(['config_pending']);
    expect(lines[0].message).toBe(CONFIG_PENDING_MESSAGE);
  });

  it('waits for Wi-Fi only with wifi policy, a cellular network and pending files', () => {
    const base = makeDevice({ networkState: 'cellular' });
    expect(deviceStatusLines(base).map((l) => l.key)).toContain('waiting_for_wifi');
    const anyNetwork = makeDevice({ networkState: 'cellular', config: { ...base.config, network: 'any' } });
    expect(deviceStatusLines(anyNetwork).map((l) => l.key)).not.toContain('waiting_for_wifi');
    const nothingPending = makeDevice({
      networkState: 'cellular',
      stats: { ...base.stats!, pending: 0, uploading: 0 },
    });
    expect(deviceStatusLines(nothingPending).map((l) => l.key)).not.toContain('waiting_for_wifi');
  });

  it('reports paused, photo access and battery', () => {
    const base = makeDevice();
    const keys = deviceStatusLines(
      makeDevice({ config: { ...base.config, paused: true }, permission: 'denied', batteryOptimized: true }),
    ).map((l) => l.key);
    expect(keys).toEqual(['paused', 'no_access', 'battery_restricted']);
    expect(deviceStatusLines(makeDevice({ permission: 'partial' })).map((l) => l.key)).toEqual(['partial_access']);
  });
});

describe('daysUntil', () => {
  it('counts whole days and handles missing values', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    expect(daysUntil('2026-10-11T00:00:00Z', now)).toBe(10);
    expect(daysUntil('2026-09-30T00:00:00Z', now)).toBe(-1);
    expect(daysUntil(null, now)).toBeNull();
  });
});

describe('error helpers', () => {
  it('reads details.reason and details.bucketIds', () => {
    const err = new ApiError('Unknown folder', 400, 'BAD_REQUEST', { reason: 'UNKNOWN_FOLDER', bucketIds: ['b1', 2, 'b2'] });
    expect(mediaSyncErrorReason(err)).toBe('UNKNOWN_FOLDER');
    expect(unknownFolderIds(err)).toEqual(['b1', 'b2']);
    expect(mediaSyncErrorReason(new Error('x'))).toBeNull();
  });
});

describe('API calls', () => {
  it('lists devices', async () => {
    server.use(http.get('*/api/media-sync/devices', () => HttpResponse.json({ data: [makeDevice()] })));
    const devices = await listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe(DEVICE_ID);
  });

  it('sends commands to the commands endpoint', async () => {
    let body: unknown;
    server.use(
      http.post(`*/api/media-sync/devices/${DEVICE_ID}/commands`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { config: makeDevice().config, configVersion: 4 } });
      }),
    );
    const result = await sendDeviceCommand(DEVICE_ID, 'retry_failed');
    expect(body).toEqual({ action: 'retry_failed' });
    expect(result.configVersion).toBe(4);
  });

  it('PATCHes the config endpoint', async () => {
    let method = '';
    server.use(
      http.patch(`*/api/media-sync/devices/${DEVICE_ID}/config`, ({ request }) => {
        method = request.method;
        return HttpResponse.json({ data: { config: makeDevice().config, configVersion: 4 } });
      }),
    );
    await updateDeviceConfig(DEVICE_ID, { network: 'any' });
    expect(method).toBe('PATCH');
  });
});

describe('androidApp service', () => {
  it('returns null for 404 NO_RELEASE', async () => {
    expect(await getLatestRelease()).toBeNull();
  });

  it('returns the current release', async () => {
    server.use(http.get('*/api/android-app/releases/latest', () => HttpResponse.json({ data: makeRelease() })));
    expect((await getLatestRelease())?.versionName).toBe('2.1.0');
  });

  it('rethrows other errors', async () => {
    server.use(
      http.get('*/api/android-app/releases/latest', () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 }),
      ),
    );
    await expect(getLatestRelease()).rejects.toBeInstanceOf(ApiError);
  });

  it('mints a download link', async () => {
    const release = makeRelease();
    server.use(
      http.post(`*/api/android-app/releases/${release.id}/download-link`, () =>
        HttpResponse.json({ data: { url: '/api/android-app/download/tok', expiresAt: '2026-10-01T00:10:00Z' } }),
      ),
    );
    expect((await createDownloadLink(release.id)).url).toBe('/api/android-app/download/tok');
  });

  it('formats megabytes', () => {
    expect(formatMegabytes('15728640')).toBe('15.0 MB');
    expect(formatMegabytes('x')).toBe('—');
  });
});
