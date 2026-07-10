import { Readable } from 'stream';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { streamToTempFile, assertDiskSpaceForDownload } from './stream-utils';

describe('streamToTempFile', () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = join(tmpdir(), `stream-utils-spec-${randomUUID()}`);
  });

  afterEach(async () => {
    await fs.unlink(tmpPath).catch(() => {});
  });

  it('writes the full stream contents to the target file', async () => {
    const contents = Buffer.from('chunk-1chunk-2chunk-3');
    const stream = Readable.from([
      Buffer.from('chunk-1'),
      Buffer.from('chunk-2'),
      Buffer.from('chunk-3'),
    ]);

    await streamToTempFile(stream, tmpPath);

    const written = await fs.readFile(tmpPath);
    expect(written.equals(contents)).toBe(true);
  });

  it('rejects and propagates the error when the stream errors', async () => {
    const errorStream = new Readable({
      read() {
        this.destroy(new Error('source stream failed'));
      },
    });

    await expect(streamToTempFile(errorStream, tmpPath)).rejects.toThrow(
      'source stream failed',
    );
  });
});

// ---------------------------------------------------------------------------
// assertDiskSpaceForDownload — pre-flight disk-space guard for video downloads
//
// The guard statfs()es the target directory and requires sizeBytes plus 20%
// headroom (DISK_GUARD_HEADROOM = 1.2) of free space (bavail * bsize),
// throwing a clear operator-facing Error otherwise. statfs is spied on so the
// tests are deterministic regardless of the real filesystem.
// ---------------------------------------------------------------------------

describe('assertDiskSpaceForDownload', () => {
  let statfsSpy: jest.SpyInstance;

  const MB = 1024 * 1024;

  function mockFreeBytes(freeBytes: number): void {
    // Express free space as bavail blocks of bsize bytes.
    statfsSpy.mockResolvedValue({ bavail: freeBytes, bsize: 1 } as never);
  }

  beforeEach(() => {
    statfsSpy = jest.spyOn(fs, 'statfs');
  });

  afterEach(() => {
    statfsSpy.mockRestore();
  });

  it('resolves when free space is comfortably above size * 1.2', async () => {
    mockFreeBytes(10 * MB);

    await expect(assertDiskSpaceForDownload(1 * MB, '/some/dir')).resolves.toBeUndefined();
  });

  it('resolves when free space exactly equals the needed size * 1.2 headroom', async () => {
    // size = 1_000_000 → needed = ceil(1_000_000 * 1.2) = 1_200_000
    mockFreeBytes(1_200_000);

    await expect(assertDiskSpaceForDownload(1_000_000, '/some/dir')).resolves.toBeUndefined();
  });

  it('throws the insufficient-disk-space error when free space is one byte below the headroom', async () => {
    mockFreeBytes(1_199_999);

    await expect(assertDiskSpaceForDownload(1_000_000, '/some/dir')).rejects.toThrow(
      /insufficient disk space for video download/,
    );
  });

  it('error message reports the needed and available MB', async () => {
    // size = 100 MB → needed = 120 MB; free = 50 MB
    mockFreeBytes(50 * MB);

    await expect(assertDiskSpaceForDownload(100 * MB, '/some/dir')).rejects.toThrow(
      'insufficient disk space for video download: need 120 MB, have 50 MB',
    );
  });

  it('accepts a bigint sizeBytes (Prisma BigInt column)', async () => {
    mockFreeBytes(10 * MB);

    await expect(
      assertDiskSpaceForDownload(BigInt(1 * MB), '/some/dir'),
    ).resolves.toBeUndefined();
  });

  it('throws for an oversized bigint too', async () => {
    mockFreeBytes(1 * MB);

    await expect(
      assertDiskSpaceForDownload(BigInt(100 * MB), '/some/dir'),
    ).rejects.toThrow(/insufficient disk space/);
  });

  it('statfs is called with the target directory path', async () => {
    mockFreeBytes(10 * MB);

    await assertDiskSpaceForDownload(1 * MB, '/var/tmp/downloads');

    expect(statfsSpy).toHaveBeenCalledWith('/var/tmp/downloads');
  });

  it('computes free space as bavail * bsize (block math, not bytes)', async () => {
    // 300 blocks of 4096 bytes = 1_228_800 free; need ceil(1_000_000 * 1.2) = 1_200_000 → passes
    statfsSpy.mockResolvedValue({ bavail: 300, bsize: 4096 } as never);
    await expect(assertDiskSpaceForDownload(1_000_000, '/d')).resolves.toBeUndefined();

    // 292 blocks of 4096 bytes = 1_196_032 < 1_200_000 → throws
    statfsSpy.mockResolvedValue({ bavail: 292, bsize: 4096 } as never);
    await expect(assertDiskSpaceForDownload(1_000_000, '/d')).rejects.toThrow(
      /insufficient disk space/,
    );
  });
});
