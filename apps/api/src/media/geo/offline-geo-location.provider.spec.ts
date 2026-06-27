/**
 * Unit tests for OfflineGeoLocationProvider.
 *
 * local-reverse-geocoder is mocked so no GeoNames dataset or network is needed.
 * The mock init() calls its callback synchronously to simulate a fast startup.
 *
 * Tests verify the admin1 fallback chain implemented in reverseGeocode:
 *
 *   admin1 = result.admin1Name
 *          ?? (countryCode === 'US' ? resolveUsState(admin1Code) : admin1Code ?? undefined)
 *
 *  1. US record, no admin1Name, valid admin1Code → resolveUsState expands the USPS abbreviation
 *  2. US record with admin1Name → admin1Name used as-is (primary path)
 *  3. Non-US record with admin1Name → admin1Name used as-is
 *  4. Non-US record, no admin1Name → admin1Code returned raw
 *  5. lookUp returns empty outer array  → null
 *  6. lookUp returns [[]] (empty inner) → null
 */

// ---------------------------------------------------------------------------
// Module mock — must precede all imports so Jest can hoist it
// ---------------------------------------------------------------------------

jest.mock('local-reverse-geocoder', () => ({
  // init: call the callback synchronously so ensureInitialized() resolves immediately
  init: jest.fn((_opts: unknown, cb: () => void) => cb()),
  lookUp: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mock declaration)
// ---------------------------------------------------------------------------

import { OfflineGeoLocationProvider } from './offline-geo-location.provider';

// Obtain typed references to the mocked functions so tests can configure them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const geocoderMock = require('local-reverse-geocoder') as {
  init: jest.Mock;
  lookUp: jest.Mock;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal subset of GeonamesRecord that the provider accesses. */
interface MinimalRecord {
  name?: string;
  asciiName?: string;
  countryCode?: string;
  countryName?: string;
  admin1Code?: string;
  admin1Name?: string;
  admin2Name?: string;
}

/**
 * Configure lookUp to call its callback once with a single-match result.
 * The provider reads results[0][0], so we wrap the record in [[record]].
 */
function driveResult(record: MinimalRecord): void {
  geocoderMock.lookUp.mockImplementationOnce(
    (
      _point: unknown,
      _maxResults: unknown,
      cb: (err: null, results: MinimalRecord[][]) => void,
    ) => cb(null, [[record]]),
  );
}

/**
 * Configure lookUp to call its callback with an empty outer array.
 * results?.[0]?.[0] → undefined → provider resolves to null.
 */
function driveNoResults(): void {
  geocoderMock.lookUp.mockImplementationOnce(
    (_point: unknown, _maxResults: unknown, cb: (err: null, results: unknown[][]) => void) =>
      cb(null, []),
  );
}

/**
 * Configure lookUp to call its callback with [[]] (empty inner array).
 * results?.[0]?.[0] → undefined → provider resolves to null.
 */
function driveEmptyInner(): void {
  geocoderMock.lookUp.mockImplementationOnce(
    (_point: unknown, _maxResults: unknown, cb: (err: null, results: unknown[][]) => void) =>
      cb(null, [[]]),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OfflineGeoLocationProvider', () => {
  let provider: OfflineGeoLocationProvider;

  beforeEach(async () => {
    // Clear call history between tests (does NOT remove implementations).
    jest.clearAllMocks();
    // Re-register the synchronous init implementation so it survives clearAllMocks.
    geocoderMock.init.mockImplementation((_opts: unknown, cb: () => void) => cb());

    provider = new OfflineGeoLocationProvider();
    // Trigger NestJS lifecycle init; our mock cb fires synchronously so this
    // resolves before any test body executes.
    await provider.onModuleInit();
  });

  // -------------------------------------------------------------------------
  // admin1 fallback chain
  // -------------------------------------------------------------------------

  describe('admin1 resolution', () => {
    it(
      'expands admin1Code via resolveUsState when US record has no admin1Name ' +
        '(core bug fix: California used to return null)',
      async () => {
        driveResult({
          name: 'San Francisco',
          countryCode: 'US',
          countryName: 'United States',
          admin1Code: 'CA',
          admin1Name: undefined,
        });

        const result = await provider.reverseGeocode(37.7749, -122.4194);

        expect(result).not.toBeNull();
        expect(result!.admin1).toBe('California');
      },
    );

    it('uses admin1Name directly when present for US records (primary path)', async () => {
      driveResult({
        name: 'Austin',
        countryCode: 'US',
        countryName: 'United States',
        admin1Code: 'TX',
        admin1Name: 'California', // intentionally mismatched to prove admin1Name wins
      });

      const result = await provider.reverseGeocode(30.2672, -97.7431);

      expect(result).not.toBeNull();
      // admin1Name takes precedence over resolveUsState(admin1Code)
      expect(result!.admin1).toBe('California');
    });

    it('uses admin1Name for non-US record when admin1Name is present', async () => {
      driveResult({
        name: 'San José',
        countryCode: 'CR',
        countryName: 'Costa Rica',
        admin1Code: 'A',
        admin1Name: 'Alajuela',
      });

      const result = await provider.reverseGeocode(9.9281, -84.0907);

      expect(result).not.toBeNull();
      expect(result!.admin1).toBe('Alajuela');
    });

    it('falls back to raw admin1Code for non-US record with no admin1Name', async () => {
      driveResult({
        name: 'Paris',
        countryCode: 'FR',
        countryName: 'France',
        admin1Code: '11',
        admin1Name: undefined,
      });

      const result = await provider.reverseGeocode(48.8566, 2.3522);

      expect(result).not.toBeNull();
      expect(result!.admin1).toBe('11');
    });
  });

  // -------------------------------------------------------------------------
  // Null result cases
  // -------------------------------------------------------------------------

  describe('null result cases', () => {
    it('resolves to null when lookUp returns an empty outer array ([])', async () => {
      driveNoResults();

      const result = await provider.reverseGeocode(0, 0);

      expect(result).toBeNull();
    });

    it('resolves to null when lookUp returns [[]] (empty inner array)', async () => {
      driveEmptyInner();

      const result = await provider.reverseGeocode(0, 0);

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Other mapped fields (smoke-check the rest of the shape)
  // -------------------------------------------------------------------------

  describe('other mapped fields', () => {
    it('maps countryName and countryCode', async () => {
      driveResult({
        name: 'Berlin',
        countryCode: 'DE',
        countryName: 'Germany',
        admin1Code: 'BE',
        admin1Name: 'Berlin',
      });

      const result = await provider.reverseGeocode(52.52, 13.405);

      expect(result!.country).toBe('Germany');
      expect(result!.countryCode).toBe('DE');
    });

    it('maps name to locality', async () => {
      driveResult({
        name: 'Tokyo',
        countryCode: 'JP',
        countryName: 'Japan',
        admin1Code: '13',
        admin1Name: 'Tokyo-to',
      });

      const result = await provider.reverseGeocode(35.6762, 139.6503);

      expect(result!.locality).toBe('Tokyo');
    });

    it('sets placeName to undefined (offline provider cannot resolve POI names)', async () => {
      driveResult({
        name: 'Rome',
        countryCode: 'IT',
        countryName: 'Italy',
        admin1Code: '07',
        admin1Name: 'Latium',
      });

      const result = await provider.reverseGeocode(41.9028, 12.4964);

      expect(result!.placeName).toBeUndefined();
    });
  });
});
