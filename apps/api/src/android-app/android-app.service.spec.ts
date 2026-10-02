import { AndroidAppService } from './android-app.service';

const SHA = Array.from({ length: 32 }, () => 'AB').join(':');
const SHA_2 = Array.from({ length: 32 }, () => 'CD').join(':');
const PACKAGE = 'memoriahub.marin.cr';

function setup(stored: unknown, groups: unknown[] = []) {
  const prisma = {
    systemSettings: {
      findUnique: jest.fn().mockResolvedValue(stored === undefined ? null : { value: stored }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    mediaSyncDevice: { groupBy: jest.fn().mockResolvedValue(groups) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };

  return { prisma, service: new AndroidAppService(prisma as never) };
}

describe('AndroidAppService', () => {
  describe('getTrustedApps', () => {
    it('reads nothing stored as no trusted apps', async () => {
      const { prisma, service } = setup(undefined);
      await expect(service.getTrustedApps()).resolves.toEqual([]);
      expect(prisma.systemSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: 'android_app' } }),
      );
    });

    it('reads a malformed stored value as no trusted apps instead of throwing', async () => {
      await expect(setup({ trustedApps: [{ packageName: 'x' }] }).service.getTrustedApps()).resolves.toEqual([]);
      await expect(setup(null).service.getTrustedApps()).resolves.toEqual([]);
    });

    it('derives the asset links from the stored list', async () => {
      const { service } = setup({ trustedApps: [{ packageName: PACKAGE, sha256: SHA }] });
      await expect(service.getAssetLinks()).resolves.toEqual([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: PACKAGE, sha256_cert_fingerprints: [SHA] },
        },
      ]);
    });
  });

  describe('getReportedApps', () => {
    it('groups ACTIVE media sync devices that report both a package and a fingerprint', async () => {
      const { prisma, service } = setup(undefined);
      await service.getReportedApps();

      expect(prisma.mediaSyncDevice.groupBy).toHaveBeenCalledWith({
        by: ['packageName', 'signingSha256'],
        where: { status: 'active', packageName: { not: null }, signingSha256: { not: null } },
        _count: { _all: true },
        _max: { lastSeenAt: true },
      });
    });

    it('merges groups whose fingerprints differ only in spelling, summing devices and keeping the latest sighting', async () => {
      const { service } = setup(undefined, [
        { packageName: PACKAGE, signingSha256: SHA, _count: { _all: 1 }, _max: { lastSeenAt: new Date('2026-09-01T00:00:00Z') } },
        { packageName: PACKAGE, signingSha256: SHA.toLowerCase(), _count: { _all: 2 }, _max: { lastSeenAt: new Date('2026-09-02T00:00:00Z') } },
        { packageName: PACKAGE, signingSha256: SHA.replace(/:/g, ''), _count: { _all: 1 }, _max: { lastSeenAt: null } },
        { packageName: 'com.other.app', signingSha256: SHA, _count: { _all: 5 }, _max: { lastSeenAt: null } },
      ]);

      await expect(service.getReportedApps([{ packageName: PACKAGE, sha256: SHA }])).resolves.toEqual([
        { packageName: 'com.other.app', sha256: SHA, deviceCount: 5, lastSeenAt: null, trusted: false },
        { packageName: PACKAGE, sha256: SHA, deviceCount: 4, lastSeenAt: '2026-09-02T00:00:00.000Z', trusted: true },
      ]);
    });

    it('marks trusted only an exact (case-sensitive package, fingerprint) match', async () => {
      const { service } = setup(undefined, [
        { packageName: PACKAGE, signingSha256: SHA_2, _count: { _all: 3 }, _max: { lastSeenAt: null } },
        { packageName: 'MemoriaHub.marin.cr', signingSha256: SHA, _count: { _all: 2 }, _max: { lastSeenAt: null } },
        { packageName: PACKAGE, signingSha256: SHA, _count: { _all: 1 }, _max: { lastSeenAt: null } },
      ]);

      const reported = await service.getReportedApps([{ packageName: PACKAGE, sha256: SHA }]);

      expect(reported.map(({ packageName, sha256, trusted }) => ({ packageName, sha256, trusted }))).toEqual([
        { packageName: PACKAGE, sha256: SHA_2, trusted: false },
        { packageName: 'MemoriaHub.marin.cr', sha256: SHA, trusted: false },
        { packageName: PACKAGE, sha256: SHA, trusted: true },
      ]);
    });

    it('skips groups missing either column', async () => {
      const { service } = setup(undefined, [
        { packageName: null, signingSha256: SHA, _count: { _all: 1 }, _max: { lastSeenAt: null } },
        { packageName: PACKAGE, signingSha256: null, _count: { _all: 1 }, _max: { lastSeenAt: null } },
      ]);
      await expect(service.getReportedApps()).resolves.toEqual([]);
    });
  });

  describe('describe', () => {
    it('returns trusted apps, reported apps flagged against them, and the asset links', async () => {
      const { service } = setup({ trustedApps: [{ packageName: PACKAGE, sha256: SHA }] }, [
        { packageName: PACKAGE, signingSha256: SHA, _count: { _all: 1 }, _max: { lastSeenAt: null } },
      ]);

      const result = await service.describe();

      expect(result.trustedApps).toEqual([{ packageName: PACKAGE, sha256: SHA }]);
      expect(result.reportedApps).toEqual([
        { packageName: PACKAGE, sha256: SHA, deviceCount: 1, lastSeenAt: null, trusted: true },
      ]);
      expect(result.assetLinks).toHaveLength(1);
    });
  });

  describe('replace', () => {
    it('upserts the row and audits which pairs a save added and removed', async () => {
      const before = { packageName: 'com.example.old', sha256: SHA };
      const after = { packageName: PACKAGE, sha256: SHA };
      const { prisma, service } = setup({ trustedApps: [before] });

      await service.replace({ trustedApps: [after] }, 'user-1');

      expect(prisma.systemSettings.upsert).toHaveBeenCalledWith({
        where: { key: 'android_app' },
        update: { value: { trustedApps: [after] }, updatedByUserId: 'user-1', version: { increment: 1 } },
        create: { key: 'android_app', value: { trustedApps: [after] }, updatedByUserId: 'user-1' },
      });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: 'user-1',
          action: 'android_app.trusted_apps.updated',
          targetType: 'system_settings',
          targetId: 'android_app',
          meta: { count: 1, added: [after], removed: [before] },
        },
      });
    });

    it('does not fail a completed save when the audit insert fails', async () => {
      const { prisma, service } = setup(undefined);
      prisma.auditEvent.create.mockRejectedValue(new Error('audit down'));

      await expect(service.replace({ trustedApps: [] }, 'user-1')).resolves.toEqual(
        expect.objectContaining({ trustedApps: [] }),
      );
      expect(prisma.systemSettings.upsert).toHaveBeenCalled();
    });
  });

  describe('ensureTrusted', () => {
    it('adds an absent pair, normalised, through an audited save', async () => {
      const existing = { packageName: 'com.example.old', sha256: SHA };
      const { prisma, service } = setup({ trustedApps: [existing] });

      await expect(
        service.ensureTrusted({ packageName: PACKAGE, sha256: SHA_2.replace(/:/g, '').toLowerCase() }, 'user-1'),
      ).resolves.toBe(true);

      expect(prisma.systemSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            value: { trustedApps: [existing, { packageName: PACKAGE, sha256: SHA_2 }] },
          }),
        }),
      );
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          meta: { count: 2, added: [{ packageName: PACKAGE, sha256: SHA_2 }], removed: [] },
        }),
      });
    });

    it('is idempotent: a pair already trusted (however the fingerprint is spelled) writes nothing', async () => {
      const { prisma, service } = setup({ trustedApps: [{ packageName: PACKAGE, sha256: SHA }] });

      await expect(service.ensureTrusted({ packageName: PACKAGE, sha256: SHA.toLowerCase() }, 'user-1')).resolves.toBe(false);
      await expect(service.ensureTrusted({ packageName: PACKAGE, sha256: SHA.replace(/:/g, '') }, 'user-1')).resolves.toBe(false);
      expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('treats a differently-cased package name as a different app', async () => {
      const { prisma, service } = setup({ trustedApps: [{ packageName: PACKAGE, sha256: SHA }] });

      await expect(service.ensureTrusted({ packageName: 'MemoriaHub.marin.cr', sha256: SHA }, 'user-1')).resolves.toBe(true);
      expect(prisma.systemSettings.upsert).toHaveBeenCalled();
    });

    it('returns false and writes nothing when the list already holds ten apps', async () => {
      const full = Array.from({ length: 10 }, (_, i) => ({ packageName: `com.example.app${i}`, sha256: SHA }));
      const { prisma, service } = setup({ trustedApps: full });

      await expect(service.ensureTrusted({ packageName: 'com.example.new', sha256: SHA }, 'user-1')).resolves.toBe(false);
      expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
    });

    it('still reports an already-trusted pair as present when the list is full', async () => {
      const full = Array.from({ length: 10 }, (_, i) => ({ packageName: `com.example.app${i}`, sha256: SHA }));
      const { prisma, service } = setup({ trustedApps: full });

      await expect(service.ensureTrusted({ packageName: 'com.example.app3', sha256: SHA }, 'user-1')).resolves.toBe(false);
      expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
    });

    it('returns false for an invalid pair instead of throwing', async () => {
      const { prisma, service } = setup(undefined);

      await expect(service.ensureTrusted({ packageName: 'app', sha256: SHA }, 'user-1')).resolves.toBe(false);
      await expect(service.ensureTrusted({ packageName: PACKAGE, sha256: 'AB:CD' }, 'user-1')).resolves.toBe(false);
      expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
    });

    it('never throws, even when the database does', async () => {
      const { prisma, service } = setup(undefined);
      prisma.systemSettings.upsert.mockRejectedValue(new Error('db down'));

      await expect(service.ensureTrusted({ packageName: PACKAGE, sha256: SHA }, 'user-1')).resolves.toBe(false);

      prisma.systemSettings.findUnique.mockRejectedValue(new Error('db down'));
      await expect(service.ensureTrusted({ packageName: PACKAGE, sha256: SHA }, 'user-1')).resolves.toBe(false);
    });
  });
});
