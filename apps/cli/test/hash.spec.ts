import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256File } from '../src/hash';

function computeSha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('sha256File', () => {
  let tmpDir: string;
  const createdFiles: string[] = [];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-hash-test-'));
  });

  afterAll(() => {
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* best-effort */ }
    }
    try { fs.rmdirSync(tmpDir); } catch { /* best-effort */ }
  });

  function writeTempFile(name: string, content: Buffer | string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    createdFiles.push(p);
    return p;
  }

  it('returns the correct SHA-256 hex digest for a file with known bytes', async () => {
    const content = Buffer.from('hello world');
    const expected = computeSha256(content);
    const filePath = writeTempFile('known.bin', content);

    const result = await sha256File(filePath);

    expect(result).toBe(expected);
    // Sanity-check against the well-known SHA-256 of "hello world"
    expect(result).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('returns a 64-character lowercase hex string', async () => {
    const filePath = writeTempFile('format-check.txt', Buffer.from('test content'));

    const result = await sha256File(filePath);

    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns different digests for files with different content', async () => {
    const fileA = writeTempFile('diffA.bin', Buffer.from('content A'));
    const fileB = writeTempFile('diffB.bin', Buffer.from('content B'));

    const hashA = await sha256File(fileA);
    const hashB = await sha256File(fileB);

    expect(hashA).not.toBe(hashB);
  });

  it('returns identical digests for files with identical content', async () => {
    const fileA = writeTempFile('sameA.bin', Buffer.from('identical content'));
    const fileB = writeTempFile('sameB.bin', Buffer.from('identical content'));

    const hashA = await sha256File(fileA);
    const hashB = await sha256File(fileB);

    expect(hashA).toBe(hashB);
  });

  it('correctly hashes a binary file (not just UTF-8 text)', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x01, 0xab, 0xcd]);
    const expected = computeSha256(bytes);
    const filePath = writeTempFile('binary.bin', bytes);

    const result = await sha256File(filePath);

    expect(result).toBe(expected);
  });

  it('correctly hashes an empty file', async () => {
    const expected = computeSha256(Buffer.alloc(0));
    const filePath = writeTempFile('empty.bin', Buffer.alloc(0));

    const result = await sha256File(filePath);

    expect(result).toBe(expected);
    // SHA-256 of empty string is well-known
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('rejects with an error for a non-existent file', async () => {
    const nonExistent = path.join(tmpDir, 'does-not-exist.bin');

    await expect(sha256File(nonExistent)).rejects.toThrow();
  });
});
