import { Readable } from 'stream';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { streamToTempFile } from './stream-utils';

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
