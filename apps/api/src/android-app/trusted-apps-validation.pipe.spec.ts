import { BadRequestException } from '@nestjs/common';

import { TrustedAppsValidationPipe } from './trusted-apps-validation.pipe';

const SHA = Array.from({ length: 32 }, () => 'AB').join(':');
const PACKAGE = 'memoriahub.marin.cr';

function reasonOf(value: unknown): unknown {
  try {
    new TrustedAppsValidationPipe().transform(value);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    const response = (err as BadRequestException).getResponse() as { details: { reason: string } };
    return response.details.reason;
  }
  throw new Error('expected the pipe to throw');
}

describe('TrustedAppsValidationPipe', () => {
  it('returns the normalised body', () => {
    expect(
      new TrustedAppsValidationPipe().transform({
        trustedApps: [{ packageName: PACKAGE, sha256: SHA.replace(/:/g, '').toLowerCase() }],
      }),
    ).toEqual({ trustedApps: [{ packageName: PACKAGE, sha256: SHA }] });
  });

  it.each([
    ['an undefined body', undefined, 'INVALID_TRUSTED_APPS'],
    ['a non-array list', { trustedApps: 'x' }, 'INVALID_TRUSTED_APPS'],
    ['a non-object entry', { trustedApps: ['x'] }, 'INVALID_TRUSTED_APPS'],
    ['a bad package name', { trustedApps: [{ packageName: 'nodot', sha256: SHA }] }, 'INVALID_PACKAGE_NAME'],
    ['a bad fingerprint', { trustedApps: [{ packageName: PACKAGE, sha256: 'nope' }] }, 'INVALID_FINGERPRINT'],
  ])('maps %s to %s', (_label, value, reason) => {
    expect(reasonOf(value)).toBe(reason);
  });

  it('reports TOO_MANY_TRUSTED_APPS ahead of per-entry problems', () => {
    const apps = Array.from({ length: 11 }, () => ({ packageName: 'bad', sha256: 'bad' }));
    expect(reasonOf({ trustedApps: apps })).toBe('TOO_MANY_TRUSTED_APPS');
  });

  it('carries every problem under details.issues', () => {
    try {
      new TrustedAppsValidationPipe().transform({ trustedApps: [{ packageName: 'bad', sha256: 'bad' }] });
      throw new Error('expected a throw');
    } catch (err) {
      const { details } = (err as BadRequestException).getResponse() as {
        details: { reason: string; issues: Array<{ path: string; reason: string }> };
      };
      expect(details.reason).toBe('INVALID_PACKAGE_NAME');
      expect(details.issues.map((issue) => [issue.path, issue.reason])).toEqual([
        ['trustedApps.0.packageName', 'INVALID_PACKAGE_NAME'],
        ['trustedApps.0.sha256', 'INVALID_FINGERPRINT'],
      ]);
    }
  });
});
