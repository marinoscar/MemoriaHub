// =============================================================================
// The primary backup target over MemoriaHub's storage providers (RETRO-D4, #580)
// =============================================================================
//
// Two halves:
//   - the platform's target kit (`describeBackupTargetConformance`) against the
//     real local-disk provider in a temporary directory: the archive streams in
//     constant memory, reads back byte for byte, and a failed write rejects;
//   - the routing rules: writes go to the pin, else the active provider; reads,
//     deletes and signed links go to the provider RECORDED ON THE RUN (legacy
//     `db-backups/` archives included), never the active one.
// =============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describeBackupTargetConformance } from '@marinoscar/platform-api/db-backup/testing';

import { LocalDiskStorageProvider } from '../../platform-extensions/storage/local-disk.driver';
import type { StorageProvider } from '@marinoscar/platform-api/storage';
import { MemoriaHubBackupTarget } from './memoriahub-backup.target';

type Run = { storageKey: string; storageProvider: string; bucket: string };

function buildTarget(options: {
  active: { id: string; provider: StorageProvider };
  byId?: Record<string, StorageProvider>;
  pin?: string | null;
  runs?: Run[];
}) {
  const resolver = {
    getActiveProvider: jest.fn(async () => options.active),
    getProviderFor: jest.fn(async (id: string, _bucket?: string | null) => options.byId?.[id] ?? options.active.provider),
  };
  const prisma = {
    databaseBackupRun: {
      findFirst: jest.fn(async ({ where }: { where: { storageKey: string } }) =>
        (options.runs ?? []).find((run) => run.storageKey === where.storageKey) ?? null,
      ),
    },
  };
  const settings = { getSettings: jest.fn(async () => ({ databaseBackup: { storageProvider: options.pin ?? '' } })) };
  const target = new MemoriaHubBackupTarget(resolver as never, prisma as never, settings as never);
  return { target, resolver, prisma };
}

function fakeProvider(name: string): StorageProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getBucket: () => `${name}-bucket`,
    download: jest.fn(async (key: string) => {
      calls.push(`download:${key}`);
      return Readable.from([Buffer.from(name)]);
    }),
    delete: jest.fn(async (key: string) => {
      calls.push(`delete:${key}`);
    }),
    getSignedDownloadUrl: jest.fn(async (key: string, opts?: { expiresIn?: number; responseContentDisposition?: string }) => {
      calls.push(`sign:${key}:${opts?.expiresIn}:${opts?.responseContentDisposition}`);
      return `https://${name}.example.test/${key}`;
    }),
    upload: jest.fn(async (key: string, stream: Readable) => {
      calls.push(`upload:${key}`);
      for await (const _chunk of stream) {
        // drain
      }
      return { key, bucket: `${name}-bucket`, location: key };
    }),
  } as unknown as StorageProvider & { calls: string[] };
}

describe('MemoriaHubBackupTarget over the local-disk provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'memoriahub-backup-target-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  describeBackupTargetConformance(
    async () => {
      const local = new LocalDiskStorageProvider(root);
      const { target } = buildTarget({ active: { id: 'local', provider: local } });
      await target.refresh();
      return target;
    },
    {
      describe,
      it,
      expect,
      // MemoriaHub's providers have no listing (the engine never lists); the local
      // provider's signed link is an API route, not a URL this test can fetch; the
      // server builds every key, and the local provider does not police `..`.
      skip: ['list', 'signedUrl', 'escapingKeys'],
    },
  );
});

describe('MemoriaHubBackupTarget routing', () => {
  it('writes to the active provider and reports its id and bucket', async () => {
    const s3 = fakeProvider('s3');
    const { target } = buildTarget({ active: { id: 's3', provider: s3 } });
    await target.refresh();
    expect(target.id).toBe('s3');
    expect(target.location).toBe('s3-bucket');

    const sink = target.openWrite('database-backups/memoriahub/2026/11/a.dump', { contentType: 'application/octet-stream', metadata: {} });
    sink.stream.end(Buffer.from('archive'));
    await sink.done;
    expect(s3.calls).toEqual(['upload:database-backups/memoriahub/2026/11/a.dump']);
  });

  it('writes to the pinned provider when databaseBackup.storageProvider is set', async () => {
    const s3 = fakeProvider('s3');
    const r2 = fakeProvider('r2');
    const { target, resolver } = buildTarget({ active: { id: 's3', provider: s3 }, byId: { r2 }, pin: 'r2' });
    await target.refresh();
    expect(target.id).toBe('r2');
    expect(resolver.getProviderFor).toHaveBeenCalledWith('r2');
    expect(resolver.getActiveProvider).not.toHaveBeenCalled();
  });

  it('reads, deletes and signs a legacy db-backups/ archive through the provider recorded on its run', async () => {
    const s3 = fakeProvider('s3');
    const r2 = fakeProvider('r2');
    const key = 'db-backups/20260101T020000Z-run-a.dump';
    const { target, resolver } = buildTarget({
      active: { id: 's3', provider: s3 },
      byId: { r2 },
      runs: [{ storageKey: key, storageProvider: 'r2', bucket: 'old-bucket' }],
    });

    const stream = await target.openRead(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('r2');

    await target.delete(key);
    const url = await target.signedDownloadUrl(key, { expiresInSeconds: 300, filename: 'a.dump' });

    expect(url).toBe(`https://r2.example.test/${key}`);
    expect(r2.calls).toEqual([`download:${key}`, `delete:${key}`, `sign:${key}:300:attachment; filename="a.dump"`]);
    expect(s3.calls).toEqual([]);
    expect(resolver.getProviderFor).toHaveBeenCalledWith('r2', 'old-bucket');
  });

  it('falls back to the current provider for a key no run records', async () => {
    const s3 = fakeProvider('s3');
    const { target } = buildTarget({ active: { id: 's3', provider: s3 } });
    await target.openRead('database-backups/memoriahub/orphan.dump');
    expect(s3.calls).toEqual(['download:database-backups/memoriahub/orphan.dump']);
  });

  it('tears the writer down when the upload fails, and rejects done', async () => {
    const broken = fakeProvider('s3');
    (broken.upload as jest.Mock).mockRejectedValue(new Error('bucket gone'));
    const { target } = buildTarget({ active: { id: 's3', provider: broken } });
    const sink = target.openWrite('database-backups/memoriahub/x.dump', { contentType: 'application/octet-stream', metadata: {} });
    const streamErrors: Error[] = [];
    sink.stream.on('error', (error) => streamErrors.push(error)); // the engine's pipeline listens the same way
    await expect(sink.done).rejects.toThrow(/bucket gone/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink.stream.destroyed).toBe(true);
    expect(streamErrors.map((e) => e.message)).toEqual(['bucket gone']);
  });

  it('has an id the platform accepts even before the first refresh', () => {
    const { target } = buildTarget({ active: { id: 's3', provider: fakeProvider('s3') } });
    expect(target.id).toMatch(/^[a-z][a-z0-9_-]{0,47}$/);
  });
});
