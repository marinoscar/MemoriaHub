import { credentialPurposeRegistry, registerCredentialPurpose } from '@marinoscar/platform-api/credentials';

import {
  FACE_PROVIDER_CREDENTIAL_PURPOSE_DEF,
  MEMORIAHUB_CREDENTIAL_PURPOSE_DEFS,
  registerMemoriaHubCredentialPurposes,
} from './credential-purposes.manifest';
import { hintToLast4 } from './hint';

describe('credential purposes manifest', () => {
  it('registers the platform and app purposes for the system tier', () => {
    const registered = new Map(credentialPurposeRegistry.list().map((d) => [d.purpose, d]));
    for (const purpose of ['storage', 'smtp', 'email_ses', 'push_vapid', 'face_provider', 'geo_provider']) {
      expect(registered.get(purpose)?.tiers).toContain('system');
    }
    expect(registered.get('face_provider')).toMatchObject({ owner: 'memoriahub-face', label: 'Face recognition provider' });
    expect(registered.get('geo_provider')).toMatchObject({ owner: 'memoriahub-geo' });
  });

  it('does not register AI provider keys (RETRO-E3)', () => {
    expect(MEMORIAHUB_CREDENTIAL_PURPOSE_DEFS.map((d) => d.purpose)).not.toContain('ai_provider');
  });

  it('registering again in-process is a no-op, but a duplicate purpose from another owner fails', () => {
    expect(() => registerMemoriaHubCredentialPurposes()).not.toThrow();
    expect(() => registerCredentialPurpose({ ...FACE_PROVIDER_CREDENTIAL_PURPOSE_DEF, owner: 'someone-else' })).toThrow(
      /already registered/,
    );
  });
});

describe('hintToLast4', () => {
  it('maps the store hint to the legacy last4 wire value', () => {
    expect(hintToLast4('••••1234')).toBe('1234');
    expect(hintToLast4('••••')).toBeNull();
    expect(hintToLast4(null)).toBeNull();
  });
});
