import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { GeoLocationProvider, GeoLocationResult } from './geo-location-provider.interface';
import { resolveUsState } from './us-state-codes';

// local-reverse-geocoder has no official @types package; use require to avoid
// strict-mode issues with the CommonJS default export.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const geocoder = require('local-reverse-geocoder') as {
  lookUp: (
    point: { latitude: number; longitude: number },
    maxResults: number,
    cb: (err: Error | null, results: Array<Array<GeonamesRecord>>) => void,
  ) => void;
  init: (opts: Record<string, unknown>, cb: () => void) => void;
};

interface GeonamesRecord {
  geoNameId?: string;
  name?: string;
  asciiName?: string;
  alternateNames?: string;
  latitude?: string;
  longitude?: string;
  featureClass?: string;
  featureCode?: string;
  countryCode?: string;
  cc2?: string;
  admin1Code?: string;
  admin2Code?: string;
  admin3Code?: string;
  admin4Code?: string;
  population?: string;
  elevation?: string;
  dem?: string;
  timezone?: string;
  modificationDate?: string;
  // Expanded by local-reverse-geocoder
  countryName?: string;
  admin1Name?: string;
  admin2Name?: string;
}

/**
 * Offline reverse geocoder using the GeoNames dataset via local-reverse-geocoder.
 *
 * - The GeoNames dataset is downloaded once to the process's data directory on
 *   startup and reused on subsequent cold starts (the library handles caching).
 * - No GPS coordinates ever leave the server when this provider is active.
 * - Resolves country → state/province/region → city reliably.
 *   Fine-grained POI/landmark resolution is not available offline and is
 *   deferred to a future phase.
 */
@Injectable()
export class OfflineGeoLocationProvider implements GeoLocationProvider, OnModuleInit {
  private readonly logger = new Logger(OfflineGeoLocationProvider.name);
  private initialized = false;

  async onModuleInit(): Promise<void> {
    await this.ensureInitialized();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    return new Promise<void>((resolve, _reject) => {
      this.logger.log('Initializing local-reverse-geocoder (GeoNames dataset)…');
      geocoder.init(
        {
          load: {
            admin1: true,         // state/province/region names — required for "pics in California"
            admin2: true,         // county/canton names — modest size, useful for locality
            admin3And4: false,    // municipality sub-divisions — not needed, saves ~allCountries download
            alternateNames: false, // DISABLED: this is the memory hog; the alternateNames.zip is
                                   // hundreds of MB and parsing it into an in-process object exhausts
                                   // the Node heap (root cause of OOM crash on startup).
          },
          citiesFileOverride: 'cities15000', // ~26k cities; far smaller than default cities1000
                                              // while still covering all family-photo localities
          dumpDirectory: process.env.GEONAMES_CACHE_DIR ?? '/tmp/geonames-cache', // volume-mountable cache
        },
        () => {
          this.initialized = true;
          this.logger.log('local-reverse-geocoder initialized');
          resolve();
        },
      );
    });
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeoLocationResult | null> {
    try {
      await this.ensureInitialized();

      const point = { latitude: lat, longitude: lng };

      return await new Promise<GeoLocationResult | null>((resolve, reject) => {
        geocoder.lookUp(point, 1, (err, results) => {
          if (err) {
            reject(err);
            return;
          }

          const result = results?.[0]?.[0];
          if (!result) {
            resolve(null);
            return;
          }

          // local-reverse-geocoder does not reliably expand admin1Name for every
          // GeoNames record — California returns null while Texas is populated.
          // Fallback chain: use admin1Name when present; for US records look up
          // the full state name from admin1Code (USPS 2-letter abbrev); for all
          // other countries use admin1Code as-is rather than returning null.
          const admin1 =
            result.admin1Name ??
            (result.countryCode === 'US'
              ? resolveUsState(result.admin1Code)
              : result.admin1Code ?? undefined);

          resolve({
            country: result.countryName ?? undefined,
            countryCode: result.countryCode ?? undefined,
            admin1,
            admin2: result.admin2Name ?? undefined,
            locality: result.name ?? result.asciiName ?? undefined,
            // Offline provider cannot reliably resolve POI/landmark names
            placeName: undefined,
          });
        });
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Reverse geocode failed for (${lat}, ${lng}): ${msg}`);
      return null;
    }
  }
}
