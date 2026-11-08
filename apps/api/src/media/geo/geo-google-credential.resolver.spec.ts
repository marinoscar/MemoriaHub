import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { GeoGoogleCredentialResolver } from './geo-google-credential.resolver';
import { FakeCredentials } from '../../../test/helpers/fake-credentials';

describe('GeoGoogleCredentialResolver', () => {
  const make = (settings: unknown, creds = new FakeCredentials()) => ({
    creds,
    resolver: new GeoGoogleCredentialResolver(
      creds as unknown as CredentialsService,
      { getSettings: jest.fn(async () => settings) } as never,
    ),
  });

  it('returns the stored key from geo_provider/google', async () => {
    const { resolver, creds } = make({ geo: { google: { enabled: true, baseUrl: null } } });
    creds.seed('geo_provider', 'google', 'k-1234567890');
    expect(await resolver.resolveApiKey()).toBe('k-1234567890');
    expect(creds.getSecret).toHaveBeenCalledWith('geo_provider', 'google');
  });

  it('returns null when no key is stored', async () => {
    expect(await make({ geo: { google: { enabled: true, baseUrl: null } } }).resolver.resolveApiKey()).toBeNull();
  });

  it('returns null, without reading the secret, when the provider is switched off', async () => {
    const { resolver, creds } = make({ geo: { google: { enabled: false, baseUrl: null } } });
    creds.seed('geo_provider', 'google', 'k-1234567890');
    expect(await resolver.resolveApiKey()).toBeNull();
    expect(creds.getSecret).not.toHaveBeenCalled();
  });

  it('treats an absent geo.google as enabled (the default)', async () => {
    const { resolver, creds } = make({});
    creds.seed('geo_provider', 'google', 'k-1234567890');
    expect(await resolver.resolveApiKey()).toBe('k-1234567890');
  });
});
