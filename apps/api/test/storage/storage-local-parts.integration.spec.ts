/**
 * Local-provider multipart uploads through the API (issue #506).
 *
 * Boots the real app (mocked Prisma) with a REAL LocalDiskStorageProvider on a
 * temp directory, and backs the two tables the upload path touches
 * (`storage_objects`, `storage_object_chunks`) with a small in-memory store, so
 * the whole sequence runs end to end over HTTP: init → PUT parts → status →
 * complete → bytes on disk.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockUserWithRelations } from '../fixtures/test-data.factory';
import { createMockTestUser, authHeader, TestUser } from '../helpers/auth-mock.helper';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';
import { StorageProviderResolver } from '../../src/storage/providers/storage-provider.resolver';
import { LocalDiskStorageProvider } from '../../src/storage/providers/local/local-disk.provider';

const PART_SIZE = 5 * 1024 * 1024; // the 5 MiB S3 minimum keeps the test quick
const APP_URL = 'https://photos.example.test';

const md5 = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`;

interface ObjectRow {
  id: string;
  name: string;
  size: bigint;
  mimeType: string;
  storageKey: string;
  storageProvider: string;
  bucket: string;
  status: string;
  s3UploadId: string | null;
  uploadedById: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface ChunkRow {
  objectId: string;
  partNumber: number;
  eTag: string;
  size: bigint;
}

describe('Storage: local-provider part upload (issue #506)', () => {
  let context: TestContext;
  let tmpDir: string;
  let local: LocalDiskStorageProvider;
  let objects: Map<string, ObjectRow>;
  let chunks: Map<string, ChunkRow>;
  let user: TestUser;

  /** 2 full parts + a short last one. */
  const source = Buffer.concat([
    Buffer.alloc(PART_SIZE, 'a'),
    Buffer.alloc(PART_SIZE, 'b'),
    Buffer.from('the final, shorter part'),
  ]);
  const slice = (n: number) => source.subarray((n - 1) * PART_SIZE, n * PART_SIZE);

  const server = () => context.app.getHttpServer();
  const pathOf = (url: string) => new URL(url).pathname;
  const chunkKey = (objectId: string, n: number) => `${objectId}:${n}`;

  function installStore(): void {
    const p = context.prismaMock;

    p.storageObject.create.mockImplementation(async ({ data }: any) => {
      const row: ObjectRow = {
        id: randomUUID(),
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      objects.set(row.id, row);
      return row;
    });
    p.storageObject.findUnique.mockImplementation(async ({ where, include }: any) => {
      const row = objects.get(where.id);
      if (!row) return null;
      if (include?.chunks) {
        return {
          ...row,
          chunks: [...chunks.values()].filter((c) => c.objectId === row.id),
        };
      }
      return { ...row };
    });
    p.storageObject.update.mockImplementation(async ({ where, data }: any) => {
      const row = objects.get(where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    });
    p.storageObject.updateMany.mockImplementation(async ({ where, data }: any) => {
      const row = objects.get(where.id);
      if (!row || (where.status && row.status !== where.status)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    p.storageObjectChunk.upsert.mockImplementation(async ({ where, create, update }: any) => {
      const { objectId, partNumber } = where.objectId_partNumber;
      const key = chunkKey(objectId, partNumber);
      const existing = chunks.get(key);
      const row = existing ? { ...existing, ...update } : { ...create };
      chunks.set(key, row);
      return row;
    });
    p.storageObjectChunk.deleteMany.mockImplementation(async ({ where }: any) => {
      let count = 0;
      for (const n of where.partNumber.in as number[]) {
        if (chunks.delete(chunkKey(where.objectId, n))) count += 1;
      }
      return { count };
    });
    p.auditEvent.create.mockResolvedValue({});
  }

  async function init(size = source.length): Promise<any> {
    const res = await request(server())
      .post('/api/storage/objects/upload/init')
      .set(authHeader(user.accessToken))
      .send({ name: 'clip.mp4', size, mimeType: 'video/mp4' })
      .expect(201);
    return res.body.data;
  }

  function putPart(url: string, body: Buffer, token = user.accessToken) {
    return request(server())
      .put(pathOf(url))
      .set(authHeader(token))
      .set('Content-Type', 'application/octet-stream')
      .send(body);
  }

  async function putAll(initData: any): Promise<Array<{ partNumber: number; eTag: string }>> {
    const parts = [];
    for (const { partNumber, url } of initData.presignedUrls) {
      const res = await putPart(url, slice(partNumber)).expect(200);
      parts.push({ partNumber, eTag: res.headers.etag as string });
    }
    return parts;
  }

  function complete(objectId: string, parts: Array<{ partNumber: number; eTag: string }>) {
    return request(server())
      .post(`/api/storage/objects/${objectId}/upload/complete`)
      .set(authHeader(user.accessToken))
      .send({ parts });
  }

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });

    const config = context.module.get(ConfigService);
    const realGet = config.get.bind(config);
    jest.spyOn(config, 'get').mockImplementation(((key: string, def?: unknown) => {
      if (key === 'storage.partSize') return PART_SIZE;
      if (key === 'appUrl') return `${APP_URL}/`; // trailing slash is trimmed
      return realGet(key, def);
    }) as any);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-local-parts-'));
    local = new LocalDiskStorageProvider({
      get: (key: string, def?: unknown) => (key === 'storage.backup.localPath' ? tmpDir : def),
    } as unknown as ConfigService);

    const resolver = context.module.get(StorageProviderResolver, { strict: false });
    jest.spyOn(resolver, 'getActiveProvider').mockResolvedValue({ id: 'local', provider: local });
    jest.spyOn(resolver, 'getProviderFor').mockResolvedValue(local);

    objects = new Map();
    chunks = new Map();
    installStore();
    user = await createMockTestUser(context);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('URL rewriting', () => {
    it('init returns absolute API part URLs and partUploadAuth "bearer"', async () => {
      const data = await init();

      expect(data.partUploadAuth).toBe('bearer');
      expect(data.partSize).toBe(PART_SIZE);
      expect(data.totalParts).toBe(3);
      expect(data.presignedUrls).toEqual(
        [1, 2, 3].map((n) => ({
          partNumber: n,
          url: `${APP_URL}/api/storage/objects/${data.objectId}/upload/parts/${n}`,
        })),
      );
      expect(JSON.stringify(data)).not.toContain('internal://');
    });

    it('part-urls returns API part URLs and partUploadAuth "bearer"', async () => {
      const data = await init();

      const res = await request(server())
        .post(`/api/storage/objects/${data.objectId}/upload/part-urls`)
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [3, 2] })
        .expect(201);

      expect(res.body.data).toEqual({
        partUploadAuth: 'bearer',
        presignedUrls: [
          { partNumber: 3, url: `${APP_URL}/api/storage/objects/${data.objectId}/upload/parts/3` },
          { partNumber: 2, url: `${APP_URL}/api/storage/objects/${data.objectId}/upload/parts/2` },
        ],
      });
    });
  });

  describe('full upload', () => {
    it('PUT 3 parts with a bearer token → status → complete → bytes match the source', async () => {
      const data = await init();

      const parts = await putAll(data);
      expect(parts.map((p) => p.eTag)).toEqual([md5(slice(1)), md5(slice(2)), md5(slice(3))]);

      const status = await request(server())
        .get(`/api/storage/objects/${data.objectId}/upload/status`)
        .set(authHeader(user.accessToken))
        .expect(200);
      expect(status.body.data).toMatchObject({
        status: 'uploading',
        uploadedParts: [1, 2, 3],
        totalParts: 3,
        uploadedBytes: String(source.length),
        totalBytes: String(source.length),
      });

      const done = await complete(data.objectId, parts).expect(201);
      expect(done.body.data.status).toBe('processing');

      const row = objects.get(data.objectId)!;
      const onDisk = fs.readFileSync(path.join(tmpDir, row.storageKey));
      expect(onDisk.equals(source)).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.multipart', data.uploadId))).toBe(false);
    });

    it('answers a part PUT like S3: empty body and a quoted MD5 ETag', async () => {
      const data = await init();

      const res = await putPart(data.presignedUrls[2].url, slice(3)).expect(200);

      expect(res.headers.etag).toBe(md5(slice(3)));
      expect(res.text).toBe('');
    });

    it('a retried PUT of the same part is idempotent', async () => {
      const data = await init();
      const url = data.presignedUrls[0].url;

      const first = await putPart(url, slice(1)).expect(200);
      const second = await putPart(url, slice(1)).expect(200);

      expect(second.headers.etag).toBe(first.headers.etag);
      expect([...chunks.values()].filter((c) => c.objectId === data.objectId)).toHaveLength(1);
      const partFile = path.join(tmpDir, '.multipart', data.uploadId, 'part-1');
      expect(fs.readFileSync(partFile).equals(slice(1))).toBe(true);
      expect(fs.readdirSync(path.dirname(partFile)).some((f) => f.endsWith('.tmp'))).toBe(false);
    });

    it('accepts a personal access token', async () => {
      const data = await init();
      const patUser = createMockUserWithRelations({ id: user.id, email: user.email });
      context.prismaMock.personalAccessToken.findUnique.mockResolvedValue({
        id: 'pat-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        user: patUser,
      });
      context.prismaMock.personalAccessToken.update.mockResolvedValue({});

      const res = await putPart(data.presignedUrls[0].url, slice(1), 'pat_test_token').expect(200);

      expect(res.headers.etag).toBe(md5(slice(1)));
    });

    it('accepts the file’s own media type, as clients send to S3', async () => {
      const data = await init();

      await request(server())
        .put(pathOf(data.presignedUrls[2].url))
        .set(authHeader(user.accessToken))
        .set('Content-Type', 'video/mp4')
        .send(slice(3))
        .expect(200);
    });
  });

  describe('missing parts', () => {
    it('complete with a missing part → 409 UPLOAD_PARTS_MISSING, no object written', async () => {
      const data = await init();
      const [p1, , p3] = data.presignedUrls;
      const e1 = (await putPart(p1.url, slice(1)).expect(200)).headers.etag;
      const e3 = (await putPart(p3.url, slice(3)).expect(200)).headers.etag;

      // Part 2 listed with a plausible eTag, but never sent.
      const res = await complete(data.objectId, [
        { partNumber: 1, eTag: e1 },
        { partNumber: 2, eTag: md5(slice(2)) },
        { partNumber: 3, eTag: e3 },
      ]).expect(409);

      expect(res.body.details).toEqual({ reason: 'UPLOAD_PARTS_MISSING', partNumbers: [2] });
      const row = objects.get(data.objectId)!;
      expect(fs.existsSync(path.join(tmpDir, row.storageKey))).toBe(false);
      expect(row.status).toBe('uploading');
    });

    it('complete that omits a part from the list → 409 UPLOAD_PARTS_MISSING', async () => {
      const data = await init();
      const parts = await putAll(data);

      const res = await complete(data.objectId, [parts[0], parts[2]]).expect(409);

      expect(res.body.details).toEqual({ reason: 'UPLOAD_PARTS_MISSING', partNumbers: [2] });
      expect(fs.existsSync(path.join(tmpDir, objects.get(data.objectId)!.storageKey))).toBe(false);
    });

    it('resume via status: re-send only the reported parts, then complete', async () => {
      const data = await init();
      const parts = await putAll(data);

      // Corrupt part 2 on disk after it was acknowledged.
      fs.writeFileSync(
        path.join(tmpDir, '.multipart', data.uploadId, 'part-2'),
        Buffer.alloc(PART_SIZE, 'X'),
      );
      const conflict = await complete(data.objectId, parts).expect(409);
      expect(conflict.body.details.partNumbers).toEqual([2]);

      // Status no longer reports the bad part, so a client resuming from it
      // knows exactly what to re-send.
      const status = await request(server())
        .get(`/api/storage/objects/${data.objectId}/upload/status`)
        .set(authHeader(user.accessToken))
        .expect(200);
      expect(status.body.data.uploadedParts).toEqual([1, 3]);

      const urls = await request(server())
        .post(`/api/storage/objects/${data.objectId}/upload/part-urls`)
        .set(authHeader(user.accessToken))
        .send({ partNumbers: conflict.body.details.partNumbers })
        .expect(201);
      const resent = await putPart(urls.body.data.presignedUrls[0].url, slice(2)).expect(200);

      await complete(data.objectId, [
        parts[0],
        { partNumber: 2, eTag: resent.headers.etag },
        parts[2],
      ]).expect(201);
      const onDisk = fs.readFileSync(path.join(tmpDir, objects.get(data.objectId)!.storageKey));
      expect(onDisk.equals(source)).toBe(true);
    });

    it('complete after the session is gone → 409 UPLOAD_SESSION_INVALID', async () => {
      const data = await init();
      const parts = await putAll(data);
      fs.rmSync(path.join(tmpDir, '.multipart', data.uploadId), { recursive: true });

      const res = await complete(data.objectId, parts).expect(409);

      expect(res.body.details).toEqual({ reason: 'UPLOAD_SESSION_INVALID' });
    });

    it('part PUT after the session is gone → 409 UPLOAD_SESSION_INVALID', async () => {
      const data = await init();
      fs.rmSync(path.join(tmpDir, '.multipart', data.uploadId), { recursive: true });

      const res = await putPart(data.presignedUrls[0].url, slice(1)).expect(409);

      expect(res.body.details).toEqual({ reason: 'UPLOAD_SESSION_INVALID' });
    });
  });

  describe('access and validation', () => {
    it('401 without credentials, and nothing is written', async () => {
      const data = await init();

      await request(server())
        .put(pathOf(data.presignedUrls[0].url))
        .set('Content-Type', 'application/octet-stream')
        .send(slice(1))
        .expect(401);

      expect(fs.readdirSync(path.join(tmpDir, '.multipart', data.uploadId))).toEqual(['.init.json']);
    });

    it('403 for a user who does not own the upload', async () => {
      const data = await init();
      const other = await createMockTestUser(context, { email: 'other@example.com' });

      await putPart(data.presignedUrls[0].url, slice(1), other.accessToken).expect(403);

      expect(fs.readdirSync(path.join(tmpDir, '.multipart', data.uploadId))).toEqual(['.init.json']);
    });

    it('404 for an unknown object', async () => {
      await putPart(`${APP_URL}/api/storage/objects/${randomUUID()}/upload/parts/1`, slice(1)).expect(404);
    });

    it('400 PART_SIZE_MISMATCH for a wrong-size part', async () => {
      const data = await init();

      const res = await putPart(data.presignedUrls[0].url, slice(1).subarray(1)).expect(400);

      expect(res.body.details).toMatchObject({
        reason: 'PART_SIZE_MISMATCH',
        partNumber: 1,
        expectedSize: PART_SIZE,
        receivedSize: PART_SIZE - 1,
      });
      expect(chunks.size).toBe(0);
    });

    it('400 PART_SIZE_MISMATCH for a last part of the wrong size', async () => {
      const data = await init();

      const res = await putPart(data.presignedUrls[2].url, Buffer.alloc(PART_SIZE, 'z')).expect(400);

      expect(res.body.details.reason).toBe('PART_SIZE_MISMATCH');
    });

    it('400 PART_OUT_OF_RANGE for a part number beyond totalParts', async () => {
      const data = await init();

      const res = await putPart(
        `${APP_URL}/api/storage/objects/${data.objectId}/upload/parts/4`,
        slice(3),
      ).expect(400);

      expect(res.body.details).toEqual({ reason: 'PART_OUT_OF_RANGE', totalParts: 3 });
    });

    it('400 UPLOAD_NOT_ACTIVE once the upload has completed', async () => {
      const data = await init();
      await complete(data.objectId, await putAll(data)).expect(201);

      const res = await putPart(data.presignedUrls[0].url, slice(1)).expect(400);

      expect(res.body.details).toEqual({ reason: 'UPLOAD_NOT_ACTIVE', status: 'processing' });
    });

    it('415 RAW_BODY_REQUIRED for a JSON body', async () => {
      const data = await init();

      const res = await request(server())
        .put(pathOf(data.presignedUrls[0].url))
        .set(authHeader(user.accessToken))
        .send({ not: 'bytes' })
        .expect(415);

      expect(res.body.details).toEqual({ reason: 'RAW_BODY_REQUIRED' });
    });

    it('keeps 415 for raw bodies on every other route', async () => {
      await request(server())
        .post('/api/storage/objects/upload/init')
        .set(authHeader(user.accessToken))
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('nope'))
        .expect(415);
    });

    it('400 PRESIGNED_PARTS_REQUIRED for an upload on a presigned-part provider', async () => {
      const data = await init();
      const s3 = createMockStorageProvider();
      const resolver = context.module.get(StorageProviderResolver, { strict: false });
      jest.spyOn(resolver, 'getProviderFor').mockResolvedValue(s3);

      const res = await putPart(data.presignedUrls[0].url, slice(1)).expect(400);

      expect(res.body.details).toEqual({ reason: 'PRESIGNED_PARTS_REQUIRED' });
    });
  });

  describe('memory', () => {
    it('never assembles a whole part in one buffer', async () => {
      const data = await init();
      const concat = jest.spyOn(Buffer, 'concat');

      try {
        await putPart(data.presignedUrls[0].url, slice(1)).expect(200);

        // Server-side code must not Buffer.concat the part. (supertest builds
        // its request body from the one Buffer we hand it, without concat.)
        const largest = Math.max(
          0,
          ...concat.mock.results.map((r) => (Buffer.isBuffer(r.value) ? r.value.length : 0)),
        );
        expect(largest).toBeLessThan(1024 * 1024);
      } finally {
        concat.mockRestore();
      }
    });
  });
});
