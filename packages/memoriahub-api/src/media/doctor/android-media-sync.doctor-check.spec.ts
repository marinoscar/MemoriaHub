import { AndroidMediaSyncDoctorCheck, decideAndroidMediaSync, readBlockedCount } from './android-media-sync.doctor-check.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 3_600_000;
const device = (over: Record<string, unknown> = {}) => ({
  name: 'Phone A',
  lastSeenAt: new Date(NOW - HOUR),
  stats: { blocked: 0 },
  permission: 'full',
  patId: 'pat-1',
  pat: { revokedAt: null, expiresAt: new Date(NOW + 30 * 24 * HOUR) },
  user: { email: 'person-a@example.test' },
  ...over,
});

describe('android.media-sync check (RETRO-J10, #624)', () => {
  it('skips with no active device', () => {
    expect(decideAndroidMediaSync([], NOW).status).toBe('skip');
  });

  it('passes for a healthy device', () => {
    expect(decideAndroidMediaSync([device() as never], NOW)).toMatchObject({ status: 'pass', data: { devices: 1 } });
  });

  it('warns for silence over 48 hours, blocked files, partial permission and a revoked token, naming the owner', () => {
    const out = decideAndroidMediaSync(
      [
        device({ lastSeenAt: new Date(NOW - 49 * HOUR) }),
        device({ name: 'B', stats: { blocked: 2 } }),
        device({ name: 'C', permission: 'partial' }),
        device({ name: 'D', pat: { revokedAt: new Date(NOW), expiresAt: new Date(NOW + HOUR) } }),
      ] as never,
      NOW,
    );
    expect(out.status).toBe('warn');
    expect(out.remedy).toBeTruthy();
    expect(out.data).toMatchObject({ devices: 4, flagged: 4, stale: 1, blocked: 1, permission: 1, credential: 1 });
    expect(out.detail).toContain('person-a@example.test');
  });

  it('reads a malformed blocked count as zero', () => {
    expect(readBlockedCount(null)).toBe(0);
    expect(readBlockedCount([])).toBe(0);
    expect(readBlockedCount({ blocked: 'x' })).toBe(0);
    expect(readBlockedCount({ blocked: 3 })).toBe(3);
  });

  it('registers under its permanent id through the diagnostics port and reads the paired tokens in one query', async () => {
    const doctor = { registerCheck: jest.fn() };
    const prisma = {
      mediaSyncDevice: { findMany: jest.fn(async () => [{ ...device(), pat: undefined }]) },
      personalAccessToken: { findMany: jest.fn(async () => [{ id: 'pat-1', revokedAt: null, expiresAt: new Date(NOW + 10 * HOUR * 24) }]) },
    };
    const check = new AndroidMediaSyncDoctorCheck(doctor as never, prisma as never);
    check.onModuleInit();
    expect(doctor.registerCheck).toHaveBeenCalledWith(check);
    expect(check.id).toBe('memoriahub.android.media-sync');
    expect(check.category).toBe('android');
    expect(check.dependsOn).toEqual(['db.connection']);
    await check.run();
    expect(prisma.personalAccessToken.findMany).toHaveBeenCalledTimes(1);
  });
});
