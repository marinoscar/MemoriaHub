/**
 * `ExportsStorageAdapter` (RETRO-H2, #596; PLATFORM-ADOPTION-SHIM(RETRO-D1)): export files are
 * written to the ACTIVE provider and streamed (never buffered), while downloads and deletes
 * resolve the provider RECORDED ON THE ROW, so a file written before a provider switch still
 * downloads and expires.
 */
import { PassThrough, Readable } from 'node:stream';

import { ExportsStorageAdapter } from '../../src/platform/exports/exports-storage.adapter';

interface Call {
  provider: string;
  op: string;
  key: string;
}

function setup(row: { storageProvider: string; bucket: string | null } | null) {
  const calls: Call[] = [];
  const provider = (id: string, bucket: string | null) => ({
    upload: async (key: string, stream: Readable) => {
      calls.push({ provider: `${id}:${bucket ?? ''}`, op: 'upload', key });
      // Proves the stream is consumed, not buffered first by the adapter.
      for await (const _chunk of stream) void _chunk;
      return { key, bucket: `${id}-bucket`, location: `${id}://${key}` };
    },
    getSignedDownloadUrl: async (key: string) => {
      calls.push({ provider: `${id}:${bucket ?? ''}`, op: 'sign', key });
      return `https://signed.example.test/${id}/${key}`;
    },
    delete: async (key: string) => {
      calls.push({ provider: `${id}:${bucket ?? ''}`, op: 'delete', key });
    },
  });
  let active = 'r2';
  const resolver = {
    getActiveProvider: async () => ({ id: active, provider: provider(active, null) }),
    getProviderFor: async (id: string, bucket?: string | null) => provider(id, bucket ?? null),
  };
  const findUnique = jest.fn(async () => row);
  // The system client (PrismaSystemService.asSystem): the row lookup crosses organizations.
  const system = { asSystem: jest.fn(() => ({ storageObject: { findUnique } })) };
  const adapter = new ExportsStorageAdapter(resolver as never, system as never);
  return { adapter, calls, findUnique, setActive: (id: string) => (active = id) };
}

describe('ExportsStorageAdapter', () => {
  it('streams an upload to the active provider and reports its id as kind', async () => {
    const { adapter, calls } = setup(null);
    const body = new PassThrough();
    const done = adapter.upload('exports/users/u/e.json', body, { mimeType: 'application/json' });
    body.end('{"a":1}');
    const result = await done;
    expect(result.bucket).toBe('r2-bucket');
    expect(adapter.kind).toBe('r2');
    expect(calls).toEqual([{ provider: 'r2:', op: 'upload', key: 'exports/users/u/e.json' }]);
  });

  it('signs and deletes through the provider recorded on the row', async () => {
    const { adapter, calls, setActive } = setup({ storageProvider: 's3', bucket: 'old-bucket' });
    setActive('local');
    await adapter.getSignedDownloadUrl('exports/users/u/e.csv', { expiresIn: 300 });
    await adapter.delete('exports/users/u/e.csv');
    expect(calls).toEqual([
      { provider: 's3:old-bucket', op: 'sign', key: 'exports/users/u/e.csv' },
      { provider: 's3:old-bucket', op: 'delete', key: 'exports/users/u/e.csv' },
    ]);
  });

  it('deletes a partial upload no row records yet through the provider it was written to', async () => {
    const { adapter, calls, setActive } = setup(null);
    const body = Readable.from(['x']);
    await adapter.upload('exports/users/u/partial.xlsx', body, { mimeType: 'application/octet-stream' });
    setActive('s3');
    await adapter.delete('exports/users/u/partial.xlsx');
    expect(calls.at(-1)).toEqual({ provider: 'r2:r2-bucket', op: 'delete', key: 'exports/users/u/partial.xlsx' });
  });
});
