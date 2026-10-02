// Must precede the first sub-key derivation — secret-cipher caches its master key.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { ConflictException, HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { deriveSubKey } from '../../common/crypto/secret-cipher';
import { DOWNLOAD_TOKEN_KEY_PURPOSE } from './android-release.constants';
import { AndroidReleaseService, isUniqueViolationOn, toPublicRelease } from './android-release.service';
import { signDownloadToken } from './download-token';

// =============================================================================
// AndroidReleaseService unit tests (issue #504): the version rules, force,
// make-current (transaction, P2002 mapping, ensureTrusted), delete through the
// RECORDED provider, the 503 storage gate, and the download token checks.
// =============================================================================

const SHA = Array.from({ length: 32 }, () => 'AB').join(':');
const PKG = 'memoriahub.marin.cr';
const USER = '22222222-2222-4222-8222-222222222222';
const RELEASE_ID = '11111111-1111-4111-8111-111111111111';

function apk(size = 2048): Buffer {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from('PK\x03\x04', 'latin1').copy(bytes, 0);
  return bytes;
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: RELEASE_ID,
    packageName: PKG,
    versionName: '1.0.0',
    versionCode: 5,
    signingSha256: SHA,
    fileSha256: 'a'.repeat(64),
    sizeBytes: BigInt(4096),
    storageKey: `android-releases/${RELEASE_ID}.apk`,
    storageProvider: 'r2',
    bucket: 'apks',
    notes: null,
    isCurrent: false,
    uploadedById: USER,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    uploadedBy: { id: USER, email: 'admin@example.com', displayName: 'Admin' },
    ...over,
  };
}

function p2002(target: string) {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed: ${target}`, {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

/** A multipart iterator: text fields, then (optionally) the file. */
async function* multipart(fields: Record<string, string>, file: Buffer | null = apk()) {
  for (const [fieldname, value] of Object.entries(fields)) {
    yield { type: 'field', fieldname, value } as never;
  }
  if (file) {
    const stream = Readable.from([file]) as Readable & { truncated?: boolean };
    stream.truncated = false;
    yield { type: 'file', fieldname: 'apk', filename: 'app.apk', file: stream } as never;
  }
}

const fields = (versionCode: number, extra: Record<string, string> = {}) => ({
  packageName: PKG,
  versionName: `1.0.${versionCode}`,
  versionCode: String(versionCode),
  signingSha256: SHA,
  ...extra,
});

function setup() {
  const stored = new Map<string, Buffer>();
  const provider = {
    upload: jest.fn(async (key: string, stream: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      stored.set(key, Buffer.concat(chunks));
      return { key, bucket: 'apks', location: key };
    }),
    download: jest.fn(async () => Readable.from([apk()])),
    delete: jest.fn(async (key: string) => {
      stored.delete(key);
    }),
    getBucket: jest.fn(() => 'apks'),
  };
  const resolver = {
    getActiveProvider: jest.fn(async () => ({ id: 'r2', provider })),
    getProviderFor: jest.fn(async () => provider),
  };
  const prisma: any = {
    androidAppRelease: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => row({ ...data, uploadedBy: null })),
      update: jest.fn(async ({ where }: any) => row({ id: where.id, isCurrent: true })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    user: { findUnique: jest.fn(async () => ({ isActive: true })) },
    auditEvent: { create: jest.fn(async () => ({})) },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const androidApp = { ensureTrusted: jest.fn(async () => true) };
  const service = new AndroidReleaseService(prisma, resolver as never, androidApp as never);
  return { service, prisma, provider, resolver, androidApp, stored };
}

async function rejection(promise: Promise<unknown>): Promise<HttpException> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
}

function reasonOf(error: HttpException): unknown {
  return (error.getResponse() as { details?: { reason?: unknown } }).details?.reason;
}

describe('AndroidReleaseService', () => {
  describe('serialization', () => {
    it('serializes the BigInt sizeBytes as a string, so JSON.stringify works', () => {
      const view = toPublicRelease(row({ sizeBytes: BigInt(157_286_400) }) as never);
      expect(view.sizeBytes).toBe('157286400');
      expect(() => JSON.stringify(view)).not.toThrow();
      expect(JSON.parse(JSON.stringify(view)).sizeBytes).toBe('157286400');
    });
  });

  describe('resolveUploadTarget', () => {
    it('is 503 STORAGE_NOT_CONFIGURED when the active S3-style provider has no bucket', async () => {
      const { service, provider } = setup();
      provider.getBucket.mockReturnValue('');
      const error = await rejection(service.resolveUploadTarget());
      expect(error.getStatus()).toBe(503);
      expect(reasonOf(error)).toBe('STORAGE_NOT_CONFIGURED');
    });

    it('is 503 when the active provider cannot be built', async () => {
      const { service, resolver } = setup();
      resolver.getActiveProvider.mockRejectedValue(new Error('bad ciphertext'));
      expect(reasonOf(await rejection(service.resolveUploadTarget()))).toBe('STORAGE_NOT_CONFIGURED');
    });

    it('accepts local disk whatever its bucket', async () => {
      const { service, resolver, provider } = setup();
      provider.getBucket.mockReturnValue('');
      resolver.getActiveProvider.mockResolvedValue({ id: 'local', provider });
      await expect(service.resolveUploadTarget()).resolves.toMatchObject({ id: 'local' });
    });
  });

  describe('upload: version rules', () => {
    it('stores the APK, records provider, bucket, size and SHA-256, makes it current and trusts the signer', async () => {
      const { service, prisma, provider, androidApp, stored } = setup();
      const bytes = apk(5000);

      const view = await service.upload(multipart(fields(6), bytes), USER);

      const data = prisma.androidAppRelease.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        packageName: PKG,
        versionCode: 6,
        signingSha256: SHA,
        sizeBytes: BigInt(bytes.length),
        fileSha256: createHash('sha256').update(bytes).digest('hex'),
        storageProvider: 'r2',
        bucket: 'apks',
        isCurrent: true,
      });
      expect(data.storageKey).toBe(`android-releases/${data.id}.apk`);
      expect(stored.get(data.storageKey)?.equals(bytes)).toBe(true);
      expect(provider.upload).toHaveBeenCalledWith(
        data.storageKey,
        expect.anything(),
        expect.objectContaining({ mimeType: 'application/vnd.android.package-archive' }),
      );
      expect(prisma.androidAppRelease.updateMany).toHaveBeenCalledWith({
        where: { isCurrent: true },
        data: { isCurrent: false },
      });
      expect(androidApp.ensureTrusted).toHaveBeenCalledWith({ packageName: PKG, sha256: SHA }, USER);
      expect(view.sizeBytes).toBe(String(bytes.length));
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'android_app.release.uploaded' }),
      });
    });

    it('refuses an existing (packageName, versionCode) with 409 RELEASE_VERSION_EXISTS before storing a byte', async () => {
      const { service, prisma, provider } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue({ id: 'existing' });

      const error = await rejection(service.upload(multipart(fields(5)), USER));

      expect(error.getStatus()).toBe(409);
      expect(reasonOf(error)).toBe('RELEASE_VERSION_EXISTS');
      expect(provider.upload).not.toHaveBeenCalled();
    });

    it('maps a racing duplicate (P2002 on the version index) to RELEASE_VERSION_EXISTS and deletes the bytes', async () => {
      const { service, prisma, provider, stored } = setup();
      prisma.androidAppRelease.create.mockRejectedValue(p2002('android_app_releases_package_name_version_code_key'));

      expect(reasonOf(await rejection(service.upload(multipart(fields(5)), USER)))).toBe('RELEASE_VERSION_EXISTS');
      expect(provider.delete).toHaveBeenCalled();
      expect(stored.size).toBe(0);
    });

    it.each([
      ['equal', 5],
      ['lower', 4],
    ])('refuses a current upload with an %s versionCode (409 RELEASE_VERSION_NOT_NEWER)', async (_label, code) => {
      const { service, prisma, provider } = setup();
      prisma.androidAppRelease.findFirst.mockResolvedValue(row({ isCurrent: true, versionCode: 5 }));

      const error = await rejection(service.upload(multipart(fields(code)), USER));

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({
        details: { reason: 'RELEASE_VERSION_NOT_NEWER', currentVersionCode: 5, currentReleaseId: RELEASE_ID },
      });
      expect(provider.upload).not.toHaveBeenCalled();
    });

    it('allows a lower versionCode with force=true, and makes it current', async () => {
      const { service, prisma } = setup();
      prisma.androidAppRelease.findFirst.mockResolvedValue(row({ isCurrent: true, versionCode: 5 }));

      await service.upload(multipart(fields(3, { force: 'true' })), USER);

      expect(prisma.androidAppRelease.create.mock.calls[0][0].data.isCurrent).toBe(true);
    });

    it('allows a lower versionCode when not made current, without trusting it', async () => {
      const { service, prisma, androidApp } = setup();
      prisma.androidAppRelease.findFirst.mockResolvedValue(row({ isCurrent: true, versionCode: 5 }));
      prisma.androidAppRelease.create.mockImplementation(async ({ data }: any) => row({ ...data }));

      const view = await service.upload(multipart(fields(3, { makeCurrent: 'false' })), USER);

      expect(view.isCurrent).toBe(false);
      expect(prisma.androidAppRelease.updateMany).not.toHaveBeenCalled();
      expect(androidApp.ensureTrusted).not.toHaveBeenCalled();
    });

    it('does not compare against the current release of another package', async () => {
      const { service, prisma } = setup();
      prisma.androidAppRelease.findFirst.mockResolvedValue(row({ isCurrent: true, versionCode: 50, packageName: 'other.app' }));

      await expect(service.upload(multipart(fields(1)), USER)).resolves.toBeDefined();
    });

    it('refuses a non-ZIP file with 400 RELEASE_NOT_AN_APK and removes the partial object', async () => {
      const { service, provider, prisma } = setup();

      const error = await rejection(service.upload(multipart(fields(1), Buffer.from('MZ not a zip')), USER));

      expect(error.getStatus()).toBe(400);
      expect(reasonOf(error)).toBe('RELEASE_NOT_AN_APK');
      expect(provider.delete).toHaveBeenCalled();
      expect(prisma.androidAppRelease.create).not.toHaveBeenCalled();
    });

    it('refuses a body without the apk file (400 RELEASE_INVALID_UPLOAD)', async () => {
      const { service } = setup();
      expect(reasonOf(await rejection(service.upload(multipart(fields(1), null), USER)))).toBe(
        'RELEASE_INVALID_UPLOAD',
      );
    });

    it('refuses invalid fields with RELEASE_INVALID_UPLOAD and the issues under details', async () => {
      const { service, provider } = setup();
      const error = await rejection(service.upload(multipart(fields(1, { versionCode: '0' })), USER));
      expect(error.getResponse()).toMatchObject({
        details: { reason: 'RELEASE_INVALID_UPLOAD', issues: [expect.objectContaining({ path: 'versionCode' })] },
      });
      expect(provider.upload).not.toHaveBeenCalled();
    });

    it('translates a multipart file-size error into 413 RELEASE_TOO_LARGE', async () => {
      const { service } = setup();
      async function* failing() {
        yield* multipart(fields(1), null);
        throw Object.assign(new Error('request file too large'), { code: 'FST_REQ_FILE_TOO_LARGE' });
      }
      const error = await rejection(service.upload(failing(), USER));
      expect(error.getStatus()).toBe(413);
      expect(reasonOf(error)).toBe('RELEASE_TOO_LARGE');
    });
  });

  describe('makeCurrent', () => {
    it('clears the old current and sets the new one in one transaction, then trusts the signer and audits', async () => {
      const { service, prisma, androidApp } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row({ versionCode: 2 }));
      prisma.androidAppRelease.findFirst.mockResolvedValue({ id: 'previous' });

      const view = await service.makeCurrent(RELEASE_ID, USER);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const clear = prisma.androidAppRelease.updateMany.mock.invocationCallOrder[0];
      const set = prisma.androidAppRelease.update.mock.invocationCallOrder[0];
      expect(clear).toBeLessThan(set);
      expect(prisma.androidAppRelease.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: RELEASE_ID }, data: { isCurrent: true } }),
      );
      expect(androidApp.ensureTrusted).toHaveBeenCalledWith({ packageName: PKG, sha256: SHA }, USER);
      expect(view.isCurrent).toBe(true);
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'android_app.release.made_current',
          meta: expect.objectContaining({ previousReleaseId: 'previous', trustedAppAdded: true }),
        }),
      });
    });

    it('allows a rollback to a lower versionCode (no version rule)', async () => {
      const { service, prisma } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row({ versionCode: 1 }));
      prisma.androidAppRelease.findFirst.mockResolvedValue(row({ id: 'newer', versionCode: 9, isCurrent: true }));

      await expect(service.makeCurrent(RELEASE_ID, USER)).resolves.toMatchObject({ isCurrent: true });
    });

    it('maps a P2002 on the one-current index to 409 RELEASE_CURRENT_CONFLICT', async () => {
      const { service, prisma } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row());
      prisma.$transaction.mockRejectedValue(p2002('android_app_releases_one_current_uniq_idx'));

      const error = await rejection(service.makeCurrent(RELEASE_ID, USER));
      expect(error).toBeInstanceOf(ConflictException);
      expect(reasonOf(error)).toBe('RELEASE_CURRENT_CONFLICT');
    });

    it('is idempotent for the current release: no transaction, no audit, trust still ensured', async () => {
      const { service, prisma, androidApp } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row({ isCurrent: true }));

      await service.makeCurrent(RELEASE_ID, USER);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
      expect(androidApp.ensureTrusted).toHaveBeenCalled();
    });

    it('still succeeds when the trusted list is full (ensureTrusted returns false)', async () => {
      const { service, prisma, androidApp } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row());
      androidApp.ensureTrusted.mockResolvedValue(false);

      await expect(service.makeCurrent(RELEASE_ID, USER)).resolves.toMatchObject({ isCurrent: true });
    });

    it('is 404 RELEASE_NOT_FOUND for an unknown id', async () => {
      const { service } = setup();
      const error = await rejection(service.makeCurrent(RELEASE_ID, USER));
      expect(error.getStatus()).toBe(404);
      expect(reasonOf(error)).toBe('RELEASE_NOT_FOUND');
    });
  });

  describe('remove', () => {
    it('refuses the current release with 409 RELEASE_IS_CURRENT and touches no bytes', async () => {
      const { service, prisma, provider } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row({ isCurrent: true }));

      const error = await rejection(service.remove(RELEASE_ID, USER));

      expect(error.getStatus()).toBe(409);
      expect(reasonOf(error)).toBe('RELEASE_IS_CURRENT');
      expect(provider.delete).not.toHaveBeenCalled();
      expect(prisma.androidAppRelease.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes the bytes through the RECORDED provider first, then the row', async () => {
      const { service, prisma, provider, resolver } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row({ storageProvider: 's3', bucket: 'old-bucket' }));

      await service.remove(RELEASE_ID, USER);

      expect(resolver.getProviderFor).toHaveBeenCalledWith('s3', 'old-bucket');
      expect(provider.delete).toHaveBeenCalledWith(`android-releases/${RELEASE_ID}.apk`);
      expect(provider.delete.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.androidAppRelease.deleteMany.mock.invocationCallOrder[0],
      );
      expect(prisma.androidAppRelease.deleteMany).toHaveBeenCalledWith({ where: { id: RELEASE_ID, isCurrent: false } });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'android_app.release.deleted' }),
      });
    });

    it('keeps the row when the storage delete fails, so it can be retried', async () => {
      const { service, prisma, provider } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row());
      provider.delete.mockRejectedValue(new Error('S3 down'));

      await expect(service.remove(RELEASE_ID, USER)).rejects.toThrow('S3 down');
      expect(prisma.androidAppRelease.deleteMany).not.toHaveBeenCalled();
    });

    it('falls back to the active provider for a row with no recorded provider', async () => {
      const { service, prisma, resolver } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row({ storageProvider: null, bucket: null }));

      await service.remove(RELEASE_ID, USER);

      expect(resolver.getProviderFor).not.toHaveBeenCalled();
      expect(resolver.getActiveProvider).toHaveBeenCalled();
    });
  });

  describe('latest and downloads', () => {
    it('latest is 404 NO_RELEASE when nothing is current', async () => {
      const { service } = setup();
      const error = await rejection(service.latest());
      expect(error.getStatus()).toBe(404);
      expect(reasonOf(error)).toBe('NO_RELEASE');
    });

    it('creates a ten-minute link that openDownload accepts, streaming from the recorded provider', async () => {
      const { service, prisma, resolver } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row());
      const now = new Date('2026-10-02T12:00:00Z');

      const link = await service.createDownloadLink(RELEASE_ID, USER, now);

      expect(link.expiresAt).toBe('2026-10-02T12:10:00.000Z');
      const token = link.url.replace('/api/android-app/download/', '');
      expect(token).toHaveLength(83);
      const opened = await service.openDownload(token, new Date(now.getTime() + 60_000));
      expect(opened).toMatchObject({ sizeBytes: 4096, fileName: 'memoriahub-android-1.0.0.apk' });
      expect(resolver.getProviderFor).toHaveBeenCalledWith('r2', 'apks');
    });

    it('is 410 DOWNLOAD_LINK_EXPIRED once the link has expired', async () => {
      const { service, prisma } = setup();
      prisma.androidAppRelease.findUnique.mockResolvedValue(row());
      const now = new Date('2026-10-02T12:00:00Z');
      const token = (await service.createDownloadLink(RELEASE_ID, USER, now)).url.split('/').pop()!;

      const error = await rejection(service.openDownload(token, new Date(now.getTime() + 601_000)));
      expect(error.getStatus()).toBe(410);
      expect(reasonOf(error)).toBe('DOWNLOAD_LINK_EXPIRED');
    });

    it('is 404 DOWNLOAD_LINK_INVALID for a tampered or foreign-key token, even when expired', async () => {
      const { service } = setup();
      const now = Math.floor(Date.now() / 1000);
      const foreign = signDownloadToken(deriveSubKey('another-purpose'), {
        releaseId: RELEASE_ID,
        userId: USER,
        expiresAt: now - 100,
      });
      for (const token of ['garbage', foreign]) {
        const error = await rejection(service.openDownload(token));
        expect(error.getStatus()).toBe(404);
        expect(reasonOf(error)).toBe('DOWNLOAD_LINK_INVALID');
      }
    });

    it('is 404 when the release was deleted or the user deactivated', async () => {
      const { service, prisma } = setup();
      const token = signDownloadToken(deriveSubKey(DOWNLOAD_TOKEN_KEY_PURPOSE), {
        releaseId: RELEASE_ID,
        userId: USER,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });

      expect((await rejection(service.openDownload(token))).getStatus()).toBe(404);

      prisma.androidAppRelease.findUnique.mockResolvedValue(row());
      prisma.user.findUnique.mockResolvedValue({ isActive: false });
      expect((await rejection(service.openDownload(token))).getStatus()).toBe(404);
    });
  });

  describe('isUniqueViolationOn', () => {
    it('recognises the index by name and nothing else', () => {
      expect(isUniqueViolationOn(p2002('android_app_releases_one_current_uniq_idx'), 'android_app_releases_one_current_uniq_idx')).toBe(true);
      expect(isUniqueViolationOn(p2002('android_app_releases_package_name_version_code_key'), 'android_app_releases_one_current_uniq_idx')).toBe(false);
      expect(isUniqueViolationOn(new Error('x'), 'android_app_releases_one_current_uniq_idx')).toBe(false);
    });
  });
});
