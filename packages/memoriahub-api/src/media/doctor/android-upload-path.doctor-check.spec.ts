import { AndroidUploadPathDoctorCheck, decideAndroidUploadPath } from './android-upload-path.doctor-check.js';

type Active = { id: string; store: { kind: string; getBucket: () => string; capabilities?: unknown } };

function check(active: Active | Error) {
  const doctor = { registerCheck: jest.fn() };
  const store = {
    active: jest.fn(async () => {
      if (active instanceof Error) throw active;
      return active;
    }),
  };
  return { doctor, check: new AndroidUploadPathDoctorCheck(doctor as never, store as never) };
}

const store = (bucket: string, capabilities?: unknown): Active['store'] => ({ kind: 'x', getBucket: () => bucket, capabilities });

describe('android.upload-path doctor check (RETRO-J10, #624)', () => {
  it('keeps the permanent id and registers through the doctor port', () => {
    const { check: c, doctor } = check({ id: 's3', store: store('b') });
    expect(c.id).toBe('memoriahub.android.upload-path');
    c.onModuleInit();
    expect(doctor.registerCheck).toHaveBeenCalledWith(c);
  });

  it('is pass for presigned parts, naming the provider', async () => {
    const { check: c } = check({ id: 'r2', store: store('b', { partUploadMode: 'presigned', acceptsPartBytes: false }) });
    const out = await c.run();
    expect(out.status).toBe('pass');
    expect(out.detail).toContain('"r2"');
    expect(out.detail).toContain('presigned');
  });

  it('is pass for the local provider through the API part route', async () => {
    const { check: c } = check({ id: 'local', store: store('', { partUploadMode: 'proxied', acceptsPartBytes: true }) });
    const out = await c.run();
    expect(out.status).toBe('pass');
    expect(out.detail).toContain('API part route');
  });

  it('fails when the active store has no bucket (and is not local), naming its key', async () => {
    const out = await check({ id: 's3', store: store('', { partUploadMode: 'presigned', acceptsPartBytes: false }) }).check.run();
    expect(out.status).toBe('fail');
    expect(out.detail).toContain('"s3"');
    expect(out.remedy).toContain('Admin Settings → Storage');
  });

  it('fails when the active store cannot be resolved', async () => {
    const out = await check(new Error('no driver')).check.run();
    expect(out.status).toBe('fail');
    expect(out.detail).toContain('"unknown"');
  });

  it('fails when a proxied store cannot take part bytes', async () => {
    const out = await check({ id: 'odd', store: store('b', { partUploadMode: 'proxied', acceptsPartBytes: false }) }).check.run();
    expect(out.status).toBe('fail');
    expect(out.detail).toContain('"odd"');
  });

  it('skips when the host does not report capabilities', async () => {
    const out = await check({ id: 'x', store: store('b') }).check.run();
    expect(out.status).toBe('skip');
  });

  it('decide: unconfigured is a fail naming the key', () => {
    expect(decideAndroidUploadPath({ providerId: null, missingProvider: 's3' }).detail).toContain('"s3"');
  });
});
