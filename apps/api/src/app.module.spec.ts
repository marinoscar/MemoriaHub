import { IdentityModule } from '@marinoscar/platform-api/identity';

import { testAuthEnabled } from './platform/identity/identity.config';

/**
 * The test login (`POST /api/auth/test/login`) mints tokens with no OAuth
 * round-trip. It is mounted by `IdentityModule.forRoot({ enableTestAuth })`;
 * this gate is what keeps it out of a production process, and a controller that
 * is not registered is invisible to `SwaggerModule.createDocument`, so it also
 * keeps the route out of the published API document. `main.ts` additionally
 * refuses to boot when `TEST_AUTH_ENABLED=true` in production.
 */
describe('test login gate', () => {
  it('is enabled outside production', () => {
    expect(testAuthEnabled('development')).toBe(true);
    expect(testAuthEnabled('test')).toBe(true);
    expect(testAuthEnabled(undefined)).toBe(true);
  });

  it('is disabled in production', () => {
    expect(testAuthEnabled('production')).toBe(false);
  });

  it('is refused by the identity package when requested in production', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => IdentityModule.forRoot({ enableTestAuth: true })).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
