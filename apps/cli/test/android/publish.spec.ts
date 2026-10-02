import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ApiError } from '../../src/api.js';
import { PreconditionError } from '../../src/android/errors.js';
import type { ApkMetadata } from '../../src/android/metadata.js';
import {
  apiClientFor,
  formatReleasesTable,
  latestRelease,
  listReleases,
  makeCurrent,
  publishRelease,
  requirePublishPermission,
  rollbackWarning,
} from '../../src/android/publish.js';
import { cleanupTemp, SHA_HEX, tempDir } from './fixtures.js';
import { multipartField, multipartFieldOrder, reasonError, release, startMockServer, type MockServer } from './mock-server.js';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  cleanupTemp();
});

const metadata: ApkMetadata = {
  packageName: 'memoriahub.marin.cr',
  versionName: '2.0.1',
  versionCode: 101,
  signingSha256: SHA_HEX,
  fileSha256: 'd'.repeat(64),
  sizeBytes: 9,
  builtAt: '2026-10-02T00:00:00.000Z',
  gitSha: null,
};

function apk(): string {
  const path = join(tempDir(), 'memoriahub-android-2.0.1.apk');
  writeFileSync(path, 'PK\u0003\u0004apk');
  return path;
}

describe('android publish (multipart)', () => {
  it('sends the text fields first and the apk last, with the bearer token', async () => {
    server = await startMockServer(() => ({ status: 201, body: { data: release({ versionName: '2.0.1', versionCode: 101 }) } }));
    const result = await publishRelease({ serverUrl: server.url, token: 'pat_x' }, apk(), metadata, { notes: 'First', makeCurrent: true, force: false });

    expect(result.versionCode).toBe(101);
    const request = server.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/admin/android-app/releases');
    expect(request.headers.authorization).toBe('Bearer pat_x');
    expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(multipartFieldOrder(request.body)).toEqual([
      'packageName',
      'versionName',
      'versionCode',
      'signingSha256',
      'notes',
      'makeCurrent',
      'force',
      'apk',
    ]);
    expect(multipartField(request.body, 'versionCode')).toBe('101');
    expect(multipartField(request.body, 'signingSha256')).toBe(SHA_HEX);
    expect(multipartField(request.body, 'makeCurrent')).toBe('true');
    expect(request.body.toString('latin1')).toContain('filename="memoriahub-android-2.0.1.apk"');
    expect(request.body.toString('latin1')).toContain('Content-Type: application/vnd.android.package-archive');
  });

  it('--no-current and no notes', async () => {
    server = await startMockServer(() => ({ status: 201, body: { data: release({ isCurrent: false }) } }));
    await publishRelease({ serverUrl: server.url, token: 't' }, apk(), metadata, { makeCurrent: false, force: true });
    const body = server.requests[0]!.body;
    expect(multipartFieldOrder(body)).not.toContain('notes');
    expect(multipartField(body, 'makeCurrent')).toBe('false');
    expect(multipartField(body, 'force')).toBe('true');
  });

  it.each([['RELEASE_VERSION_EXISTS'], ['RELEASE_VERSION_NOT_NEWER']])('maps %s to the bump hint', async (reason) => {
    server = await startMockServer(() => reasonError(409, reason, 'Not allowed'));
    const failure = publishRelease({ serverUrl: server.url, token: 't' }, apk(), metadata, { makeCurrent: true, force: false });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(
      publishRelease({ serverUrl: server.url, token: 't' }, apk(), metadata, { makeCurrent: true, force: false }),
    ).rejects.toThrow(/run `memoriahub android version --bump patch`/);
  });

  it('passes other refusals through with their message', async () => {
    server = await startMockServer(() => reasonError(400, 'RELEASE_NOT_AN_APK', 'Not an APK'));
    await expect(
      publishRelease({ serverUrl: server.url, token: 't' }, apk(), metadata, { makeCurrent: true, force: false }),
    ).rejects.toThrow(/Not an APK/);
  });
});

describe('server JSON calls', () => {
  it('pre-checks system_settings:write through /api/auth/me', async () => {
    let permissions = ['system_settings:read'];
    server = await startMockServer(() => ({ status: 200, body: { data: { email: 'a@x', permissions } } }));
    const client = apiClientFor({ serverUrl: server.url, token: 't' }, { quick: true });
    await expect(requirePublishPermission(client, server.url)).rejects.toThrow(/lacks system_settings:write/);
    permissions = ['system_settings:write'];
    await expect(requirePublishPermission(client, server.url)).resolves.toMatchObject({ email: 'a@x' });
  });

  it('a rejected token is a precondition', async () => {
    server = await startMockServer(() => ({ status: 401, body: { message: 'Unauthorized' } }));
    await expect(requirePublishPermission(apiClientFor({ serverUrl: server.url, token: 't' }, { quick: true }), server.url)).rejects.toBeInstanceOf(
      PreconditionError,
    );
  });

  it('latest: 404 NO_RELEASE means nothing published; another 404 means an old server', async () => {
    let reply = reasonError(404, 'NO_RELEASE');
    server = await startMockServer(() => reply);
    const client = apiClientFor({ serverUrl: server.url, token: 't' }, { quick: true });
    await expect(latestRelease(client)).resolves.toBeNull();
    reply = { status: 404, body: { message: 'Cannot GET', code: 'NOT_FOUND' } } as typeof reply;
    await expect(latestRelease(client)).rejects.toThrow(/predates Android releases/);
  });

  it('lists releases and makes one current', async () => {
    server = await startMockServer((request) =>
      request.method === 'GET'
        ? { status: 200, body: { data: [release(), release({ id: '2', versionCode: 99, versionName: '1.9.0', isCurrent: false })] } }
        : { status: 200, body: { data: release({ id: '2', isCurrent: true }) } },
    );
    const client = apiClientFor({ serverUrl: server.url, token: 't' }, { quick: true });
    const list = await listReleases(client);
    expect(list).toHaveLength(2);
    expect(formatReleasesTable(list)).toContain('* = current release');
    expect(formatReleasesTable(list).split('\n')[1]).toMatch(/^\*\s+2\.0\.0\s+100\s+1\.9 MB/);
    await makeCurrent(client, '2');
    expect(server.requests[1]).toMatchObject({ method: 'POST', url: '/api/admin/android-app/releases/2/make-current' });
  });

  it('warns only for a rollback to a lower versionCode', () => {
    const current = release() as never;
    expect(rollbackWarning(release({ id: '2', versionCode: 99 }) as never, current)).toMatch(/ROLLS BACK/);
    expect(rollbackWarning(release({ id: '3', versionCode: 101 }) as never, current)).toBeUndefined();
    expect(rollbackWarning(release({ id: '4' }) as never, undefined)).toBeUndefined();
  });
});
