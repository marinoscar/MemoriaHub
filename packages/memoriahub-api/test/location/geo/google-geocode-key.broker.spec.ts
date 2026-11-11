import { GEO_GOOGLE_SECRET_KIND, GoogleGeocodeKeyBroker } from '../../../src/location/geo/google-geocode-key.broker.js';
import { GeoGoogleCredentialResolver } from '../../../src/location/geo/geo-google-credential.resolver.js';
import { FakeGeoSecrets } from '../../helpers/geo-secrets.js';
import { mediaItemJob } from '../../helpers/job-fixtures.js';
import { settingsPortFrom } from '../../helpers/settings-port.js';

const FIXTURE_KEY = 'k-fixture-1234567890';

function make(settings: Record<string, unknown>, key: string | null = FIXTURE_KEY) {
  const creds = new FakeGeoSecrets();
  if (key) creds.seed('geo_provider', 'google', key);
  const settingsPort = settingsPortFrom(settings) as never;
  const resolver = new GeoGoogleCredentialResolver(creds, settingsPort);
  const broker = new GoogleGeocodeKeyBroker(creds, settingsPort, resolver);
  return { broker, creds };
}

describe('GoogleGeocodeKeyBroker', () => {
  const google = { geo: { reverseProvider: 'google', google: { enabled: true, baseUrl: null } } };

  it('has the permanent kind geo.google', () => {
    expect(make(google).broker.kind).toBe(GEO_GOOGLE_SECRET_KIND);
    expect(GEO_GOOGLE_SECRET_KIND).toBe('geo.google');
  });

  describe('usable()', () => {
    it('is ok when the provider is google, switched on, and a key is stored', async () => {
      expect(await make(google).broker.usable()).toEqual({ ok: true });
    });

    it('is ok when geo.google is absent (enabled by default)', async () => {
      expect(await make({ geo: { reverseProvider: 'google' } }).broker.usable()).toEqual({ ok: true });
    });

    it.each(['offline', 'nominatim'])('is not usable for the %s provider, with a reason and a remedy', async (provider) => {
      const result = await make({ geo: { reverseProvider: provider } }).broker.usable();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(provider);
        expect(result.remedy).toBeTruthy();
      }
    });

    it('is not usable when the Google provider is switched off', async () => {
      const result = await make({ geo: { reverseProvider: 'google', google: { enabled: false } } }).broker.usable();
      expect(result.ok).toBe(false);
    });

    it('is not usable when no key is stored', async () => {
      const result = await make(google, null).broker.usable();
      expect(result.ok).toBe(false);
    });

    it('never reads the secret: it asks only for the credential metadata', async () => {
      const { broker, creds } = make(google);
      await broker.usable();
      expect(creds.get).not.toHaveBeenCalled();
      expect(creds.status).toHaveBeenCalledWith('geo_provider', 'google');
    });

    it('carries no key material in the reason or remedy of a refusal', async () => {
      for (const settings of [{ geo: { reverseProvider: 'offline' } }, { geo: { reverseProvider: 'google', google: { enabled: false } } }]) {
        expect(JSON.stringify(await make(settings).broker.usable())).not.toContain(FIXTURE_KEY);
      }
      expect(JSON.stringify(await make(google, null).broker.usable())).not.toContain(FIXTURE_KEY);
    });
  });

  describe('issue()', () => {
    const until = new Date('2026-01-01T01:00:00Z');

    it('returns the key only in material, bounded by the lease, under a non-secret handle', async () => {
      const issued = await make(google).broker.issue(mediaItemJob('geocode', 'media-1', 'circle-1', { id: 'job-9' }), until);
      expect(issued.material).toEqual({ apiKey: FIXTURE_KEY });
      expect(issued.expiresAt).toEqual(until);
      expect(issued.handle).toBe('geo-google-job-9');
      expect(issued.handle).not.toContain(FIXTURE_KEY);
    });

    it('is idempotent per job: the same handle again', async () => {
      const { broker } = make(google);
      const job = mediaItemJob('geocode', 'media-1', 'circle-1', { id: 'job-9' });
      expect((await broker.issue(job, until)).handle).toBe((await broker.issue(job, until)).handle);
    });

    it('returns no material, and its error names no key, when the key is missing or switched off', async () => {
      const job = mediaItemJob('geocode');
      for (const broker of [
        make(google, null).broker,
        make({ geo: { reverseProvider: 'google', google: { enabled: false } } }).broker,
      ]) {
        const error = await broker.issue(job, until).then(
          () => null,
          (e: Error) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error!.message).not.toContain(FIXTURE_KEY);
      }
    });
  });

  it('revoke() is an idempotent no-op that succeeds for any handle', async () => {
    const { broker } = make(google);
    await expect(broker.revoke('geo-google-job-9')).resolves.toBeUndefined();
    await expect(broker.revoke('geo-google-job-9')).resolves.toBeUndefined();
  });
});
