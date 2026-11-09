/**
 * The `local` storage driver (RETRO-D1, #563) against the platform's driver kit,
 * plus the MemoriaHub-specific promises the kit does not cover: the on-disk layout
 * every object written before the cutover lives in, the root-escape refusal, and
 * the signed download token.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describeStorageDriverConformance } from '@marinoscar/platform-api/storage/testing';

import {
  LOCAL_DOWNLOAD_PATH,
  LocalDiskStorageProvider,
  localStorageDriver,
  resolveLocalRootDir,
  verifyLocalDownloadToken,
} from '../../src/platform-extensions/storage/local-disk.driver';

process.env['SECRETS_ENCRYPTION_KEY'] ??= Buffer.alloc(32, 7).toString('base64');

const root = mkdtempSync(join(tmpdir(), 'mh-local-driver-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describeStorageDriverConformance(localStorageDriver, {
  describe,
  it,
  expect,
  settings: { rootDir: root },
  secrets: {},
  readSignedUrl: async (url) => {
    const token = new URL(url, 'https://photos.example.test').pathname.slice(LOCAL_DOWNLOAD_PATH.length);
    const verdict = verifyLocalDownloadToken(token);
    if (!verdict.ok) throw new Error(`token ${verdict.reason}`);
    return readFileSync(join(verdict.root, verdict.key));
  },
});

describe('local driver: what the cutover relies on', () => {
  it('keeps the id `local` (existing rows record it)', () => {
    expect(localStorageDriver.id).toBe('local');
    expect(new LocalDiskStorageProvider(root).kind).toBe('local');
  });

  it('reads an object written by the pre-RETRO-D1 provider where it lies (<root>/<key> + .meta.json)', async () => {
    const key = 'uploads/1700000000000/legacy-object.jpg';
    mkdirSync(join(root, 'uploads', '1700000000000'), { recursive: true });
    writeFileSync(join(root, key), 'legacy-bytes');
    writeFileSync(join(root, `${key}.meta.json`), JSON.stringify({ mimeType: 'image/jpeg', metadata: { a: 'b' } }));

    const provider = new LocalDiskStorageProvider(root);
    const chunks: Buffer[] = [];
    for await (const chunk of await provider.download(key)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('legacy-bytes');
    expect(await provider.getMetadata(key)).toEqual({ a: 'b' });
    expect(await provider.contentTypeOf(key)).toBe('image/jpeg');
  });

  it('records the root basename as the bucket, as rows written before did', () => {
    expect(new LocalDiskStorageProvider('/srv/memoriahub-media').getBucket()).toBe('memoriahub-media');
  });

  it('defaults to the historical BACKUP_LOCAL_PATH default when no root is configured', () => {
    expect(resolveLocalRootDir({ rootDir: '' })).toBe('/tmp/memoriahub-backup');
  });

  it('refuses a key that escapes the root', async () => {
    const provider = new LocalDiskStorageProvider(root);
    await expect(provider.upload('../outside.txt', Readable.from(['x']), { mimeType: 'text/plain' })).rejects.toThrow(
      /Refusing the object key/,
    );
    expect(existsSync(join(root, '..', 'outside.txt'))).toBe(false);
  });

  it('declares API-proxied parts (partUploadAuth bearer on init)', () => {
    expect(new LocalDiskStorageProvider(root).partUploadMode).toBe('proxied');
  });

  it('signs a same-origin download URL whose token names the root and the key', async () => {
    const provider = new LocalDiskStorageProvider(root, 'https://photos.example.test');
    const url = await provider.getSignedDownloadUrl('thumbnails/abc-0123456789abcdef.jpg', { expiresIn: 60 });
    expect(url.startsWith(`https://photos.example.test${LOCAL_DOWNLOAD_PATH}`)).toBe(true);
    const verdict = verifyLocalDownloadToken(url.slice(`https://photos.example.test${LOCAL_DOWNLOAD_PATH}`.length));
    expect(verdict).toMatchObject({ ok: true, root, key: 'thumbnails/abc-0123456789abcdef.jpg' });
  });

  it('rejects a tampered or expired token', () => {
    expect(verifyLocalDownloadToken('not-a-token')).toEqual({ ok: false, reason: 'invalid' });
    const provider = new LocalDiskStorageProvider(root);
    return provider.getSignedDownloadUrl('a/b.jpg', { expiresIn: -10 }).then((url) => {
      expect(verifyLocalDownloadToken(url.slice(LOCAL_DOWNLOAD_PATH.length))).toEqual({ ok: false, reason: 'expired' });
    });
  });
});
