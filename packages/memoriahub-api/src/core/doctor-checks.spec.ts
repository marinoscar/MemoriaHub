import { DOCTOR_CHECK_ID_PREFIX, doctorCheckId, errorMessage, fail, pass, readSystemNamespaces, skip, warn } from './doctor-checks.js';

describe('the diagnostics helpers (RETRO-J10, #624)', () => {
  it('builds the permanent check id', () => {
    expect(DOCTOR_CHECK_ID_PREFIX).toBe('memoriahub');
    expect(doctorCheckId('android', 'media-sync')).toBe('memoriahub.android.media-sync');
  });

  it('shapes the four outcomes, with the remedy on warn and fail only', () => {
    expect(pass('ok', { n: 1 })).toEqual({ status: 'pass', detail: 'ok', data: { n: 1 } });
    expect(skip('off')).toEqual({ status: 'skip', detail: 'off' });
    expect(warn('hm', 'do x')).toEqual({ status: 'warn', detail: 'hm', remedy: 'do x' });
    expect(fail('bad', 'do y', { p: 'q' })).toEqual({ status: 'fail', detail: 'bad', remedy: 'do y', data: { p: 'q' } });
  });

  it('never leaks a stack', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });

  it('reads the named namespaces into one document-shaped object', async () => {
    const settings = {
      readSystem: jest.fn(async (name: string) => ({ value: name === 'features' ? { a: true } : undefined, version: 1 })),
    };
    const doc = await readSystemNamespaces(settings as never, ['features', 'socialMedia']);
    expect(doc.features).toEqual({ a: true });
    expect(doc.socialMedia).toBeUndefined();
    expect(doc.features?.['a']).toBe(true);
  });

  it('prefers the port\'s read-only peekSystem, so a diagnostics read never creates a settings row', async () => {
    const settings = {
      readSystem: jest.fn(async () => {
        throw new Error('readSystem may write on a fresh install');
      }),
      peekSystem: jest.fn(async (name: string) => ({ value: { name }, version: 0 })),
    };
    const doc = await readSystemNamespaces(settings as never, ['features']);
    expect(doc.features).toEqual({ name: 'features' });
    expect(settings.readSystem).not.toHaveBeenCalled();
  });
});
