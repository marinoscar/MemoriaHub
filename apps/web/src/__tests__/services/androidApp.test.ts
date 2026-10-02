/**
 * `services/androidApp.ts` (issue #516): the client-side mirrors of the API's
 * validation, the CLI sidecar parser, the multipart field order the streaming
 * upload route needs, and the XHR upload (progress, 401 retry, envelope
 * unwrap, `details.reason` preserved on errors).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../services/api';
import {
  buildReleaseFormData,
  errorReason,
  isValidFingerprint,
  isValidPackageName,
  normalizeSha256,
  parseReleaseSidecar,
  uploadRelease,
  type UploadReleaseInput,
} from '../../services/androidApp';

const COLON = Array.from({ length: 32 }, (_, i) => (i % 16).toString(16).toUpperCase().repeat(2)).join(':');
const BARE_LOWER = COLON.replace(/:/g, '').toLowerCase();

describe('fingerprint and package validation (mirrors android-app.schema.ts)', () => {
  it('normalises 64 bare hex digits in any case to the uppercase colon form', () => {
    expect(normalizeSha256(BARE_LOWER)).toBe(COLON);
    expect(normalizeSha256(`  ${COLON.toLowerCase()}  `)).toBe(COLON);
  });

  it('accepts the colon form and bare hex in either case, rejects anything else', () => {
    expect(isValidFingerprint(COLON)).toBe(true);
    expect(isValidFingerprint(COLON.toLowerCase())).toBe(true);
    expect(isValidFingerprint(BARE_LOWER)).toBe(true);
    expect(isValidFingerprint(BARE_LOWER.slice(2))).toBe(false);
    expect(isValidFingerprint('not-a-fingerprint')).toBe(false);
    expect(isValidFingerprint('')).toBe(false);
  });

  it('accepts application ids with two or more segments, case-sensitively', () => {
    expect(isValidPackageName('memoriahub.marin.cr')).toBe(true);
    expect(isValidPackageName('memoriahub.marin.cr.debug')).toBe(true);
    expect(isValidPackageName('MemoriaHub.Marin_Cr')).toBe(true);
    expect(isValidPackageName('memoriahub')).toBe(false);
    expect(isValidPackageName('1memoria.hub')).toBe(false);
    expect(isValidPackageName('memoria..hub')).toBe(false);
  });
});

describe('parseReleaseSidecar', () => {
  it('reads the CLI sidecar and normalises its lowercase colon-less signer', () => {
    const meta = parseReleaseSidecar(
      JSON.stringify({
        packageName: 'memoriahub.marin.cr',
        versionName: '2.1.0',
        versionCode: 210,
        signingSha256: BARE_LOWER,
        fileSha256: 'AB'.repeat(32),
        sizeBytes: 4096,
        builtAt: '2026-10-01T00:00:00Z',
        gitSha: 'abc123',
      }),
    );
    expect(meta).toEqual({
      packageName: 'memoriahub.marin.cr',
      versionName: '2.1.0',
      versionCode: 210,
      signingSha256: COLON,
      fileSha256: 'ab'.repeat(32),
      sizeBytes: 4096,
    });
  });

  it('returns null for non-JSON, arrays and objects with nothing useful', () => {
    expect(parseReleaseSidecar('not json')).toBeNull();
    expect(parseReleaseSidecar('[]')).toBeNull();
    expect(parseReleaseSidecar('{"foo":1}')).toBeNull();
  });

  it('ignores malformed fields instead of failing', () => {
    expect(parseReleaseSidecar('{"versionName":"2.0.0","versionCode":1.5}')).toEqual({ versionName: '2.0.0' });
  });
});

function input(overrides: Partial<UploadReleaseInput> = {}): UploadReleaseInput {
  return {
    apk: new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'memoriahub-android-2.1.0.apk'),
    packageName: 'memoriahub.marin.cr',
    versionName: '2.1.0',
    versionCode: 210,
    signingSha256: COLON,
    notes: '  New sync  ',
    makeCurrent: true,
    ...overrides,
  };
}

describe('buildReleaseFormData', () => {
  it('puts every text field before the apk file field', () => {
    const keys = [...buildReleaseFormData(input()).keys()];
    expect(keys).toEqual([
      'packageName',
      'versionName',
      'versionCode',
      'signingSha256',
      'notes',
      'makeCurrent',
      'force',
      'apk',
    ]);
  });

  it('serialises booleans as true/false and trims notes, omitting blank notes', () => {
    const form = buildReleaseFormData(input({ force: true, makeCurrent: false }));
    expect(form.get('notes')).toBe('New sync');
    expect(form.get('makeCurrent')).toBe('false');
    expect(form.get('force')).toBe('true');
    expect(buildReleaseFormData(input({ notes: '   ' })).has('notes')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// uploadRelease over a fake XMLHttpRequest
// -----------------------------------------------------------------------------

interface Planned {
  status: number;
  body: unknown;
}

class FakeXhr {
  static plan: Planned[] = [];
  static instances: FakeXhr[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  withCredentials = false;
  status = 0;
  responseText = '';
  body: unknown;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    const next = FakeXhr.plan.shift()!;
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 } as ProgressEvent);
      this.status = next.status;
      this.responseText = JSON.stringify(next.body);
      this.onload?.();
    });
  }
}

describe('uploadRelease', () => {
  beforeEach(() => {
    FakeXhr.plan = [];
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    vi.spyOn(api, 'getAccessToken').mockReturnValue('jwt-1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POSTs multipart with the bearer token, reports progress and unwraps { data }', async () => {
    FakeXhr.plan.push({ status: 201, body: { data: { id: 'r1', versionName: '2.1.0' } } });
    const onProgress = vi.fn();

    const result = await uploadRelease(input(), onProgress);

    expect(result).toEqual({ id: 'r1', versionName: '2.1.0' });
    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toMatch(/\/api\/admin\/android-app\/releases$/);
    expect(xhr.headers.Authorization).toBe('Bearer jwt-1');
    expect(xhr.headers['Content-Type']).toBeUndefined();
    expect(xhr.body).toBeInstanceOf(FormData);
    expect(onProgress).toHaveBeenCalledWith({ loaded: 2, total: 4 });
  });

  it('throws an ApiError carrying details.reason on a 409', async () => {
    FakeXhr.plan.push({
      status: 409,
      body: {
        statusCode: 409,
        code: 'CONFLICT',
        message: 'not newer',
        details: { reason: 'RELEASE_VERSION_NOT_NEWER', currentVersionCode: 210 },
      },
    });

    const err = await uploadRelease(input()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe('not newer');
    expect(errorReason(err)).toBe('RELEASE_VERSION_NOT_NEWER');
  });

  it('refreshes the token once on a 401 and retries with a fresh body', async () => {
    FakeXhr.plan.push({ status: 401, body: { message: 'Unauthorized' } });
    FakeXhr.plan.push({ status: 201, body: { data: { id: 'r2' } } });
    const refresh = vi.spyOn(api, 'refreshToken').mockResolvedValue(true);

    const result = await uploadRelease(input());

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(FakeXhr.instances[1].body).not.toBe(FakeXhr.instances[0].body);
    expect(result).toEqual({ id: 'r2' });
  });
});

describe('errorReason', () => {
  it('is null for non-ApiErrors and errors without a reason', () => {
    expect(errorReason(new Error('x'))).toBeNull();
    expect(errorReason(new ApiError('x', 500))).toBeNull();
    expect(errorReason(new ApiError('x', 400, 'BAD_REQUEST', { reason: 'INVALID_FINGERPRINT' }))).toBe(
      'INVALID_FINGERPRINT',
    );
  });
});
