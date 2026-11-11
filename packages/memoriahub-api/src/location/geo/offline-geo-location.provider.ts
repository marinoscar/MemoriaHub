import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { GeoLocationProvider, GeoLocationResult } from './geo-location-provider.interface.js';
import { resolveUsState } from './us-state-codes.js';

/** The two calls of `local-reverse-geocoder` this provider uses (the library ships no types). */
interface LocalReverseGeocoder {
  lookUp: (
    point: { latitude: number; longitude: number },
    maxResults: number,
    cb: (err: Error | null, results: Array<Array<GeonamesRecord>>) => void,
  ) => void;
  init: (opts: Record<string, unknown>, cb: () => void) => void;
}

let loaded: LocalReverseGeocoder | undefined;

/**
 * Loads `local-reverse-geocoder` on first use: it is an optional peer of the package (a host that never
 * selects the offline provider need not install it) and the library downloads its dataset on `init`.
 */
function geocoderLibrary(): LocalReverseGeocoder {
  if (loaded) return loaded;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('local-reverse-geocoder') as LocalReverseGeocoder;
  } catch (cause) {
    throw new Error(
      'The offline geocoder needs the optional peer dependency "local-reverse-geocoder"; install it or select another reverse provider (geo.reverseProvider).',
      { cause },
    );
  }
  return loaded;
}

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
 *
 * @stability experimental
 */
@Injectable()
export class OfflineGeoLocationProvider implements GeoLocationProvider, OnModuleInit {
  private readonly logger = new Logger(OfflineGeoLocationProvider.name);
  private initialized = false;

  /** Loads the GeoNames dataset at start-up (the library downloads it once and caches it). */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureInitialized();
    } catch (error) {
      // A host without the optional peer must still boot the slice; a lookup reports the problem when the offline provider is used.
      this.logger.warn(`Offline geocoder not initialized: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    return new Promise<void>((resolve, _reject) => {
      this.logger.log('Initializing local-reverse-geocoder (GeoNames dataset)…');
      geocoderLibrary().init(
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

  /**
   * Reverse-geocodes a coordinate pair from the local dataset.
   *
   * @param lat - latitude in decimal degrees.
   * @param lng - longitude in decimal degrees.
   */
  async reverseGeocode(lat: number, lng: number): Promise<GeoLocationResult | null> {
    // Defensive guard mirroring GeoLocationService's choke point: the offline
    // kd-tree geocoder has no "no location" concept and returns a bogus nearest
    // city (Talnakh, RU) for a NaN input. Duplicated here so the guard applies
    // regardless of which wrapper calls this provider directly.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      this.logger.debug(`reverseGeocode called with non-finite coordinates (${lat}, ${lng}); returning null`);
      return null;
    }

    try {
      await this.ensureInitialized();

      const point = { latitude: lat, longitude: lng };

      return await new Promise<GeoLocationResult | null>((resolve, reject) => {
        geocoderLibrary().lookUp(point, 1, (err, results) => {
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
