import { GeoGoogleCredentialResolver } from '../../../src/location/geo/geo-google-credential.resolver.js';
import { FakeGeoSecrets } from '../../helpers/geo-secrets.js';
import { settingsPortFrom } from '../../helpers/settings-port.js';

describe('GeoGoogleCredentialResolver', () => {
  const make = (settings: Record<string, unknown>, creds = new FakeGeoSecrets()) => ({
    creds,
    resolver: new GeoGoogleCredentialResolver(creds, settingsPortFrom(settings) as never),
  });

  it('returns the stored key from geo_provider/google', async () => {
    const { resolver, creds } = make({ geo: { google: { enabled: true, baseUrl: null } } });
    creds.seed('geo_provider', 'google', 'k-1234567890');
    expect(await resolver.resolveApiKey()).toBe('k-1234567890');
    expect(creds.get).toHaveBeenCalledWith('geo_provider', 'google');
  });

  it('returns null when no key is stored', async () => {
    expect(await make({ geo: { google: { enabled: true, baseUrl: null } } }).resolver.resolveApiKey()).toBeNull();
  });

  it('returns null, without reading the secret, when the provider is switched off', async () => {
    const { resolver, creds } = make({ geo: { google: { enabled: false, baseUrl: null } } });
    creds.seed('geo_provider', 'google', 'k-1234567890');
    expect(await resolver.resolveApiKey()).toBeNull();
    expect(creds.get).not.toHaveBeenCalled();
  });

  it('treats an absent geo.google as enabled (the default)', async () => {
    const { resolver, creds } = make({});
    creds.seed('geo_provider', 'google', 'k-1234567890');
    expect(await resolver.resolveApiKey()).toBe('k-1234567890');
  });
});
