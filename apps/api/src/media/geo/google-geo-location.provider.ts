import { Injectable, Logger } from '@nestjs/common';
import { GeoLocationResult } from './geo-location-provider.interface';

@Injectable()
export class GoogleGeoLocationProvider {
  private readonly logger = new Logger(GoogleGeoLocationProvider.name);

  async reverseGeocodeWithKey(lat: number, lng: number, apiKey: string): Promise<GeoLocationResult | null> {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    try {
      const response = await fetch(url);
      const data = await response.json() as {
        status: string;
        results: Array<{
          address_components: Array<{ long_name: string; short_name: string; types: string[] }>;
          formatted_address: string;
        }>;
        error_message?: string;
      };

      if (data.status === 'ZERO_RESULTS') return null;
      if (data.status === 'REQUEST_DENIED') {
        this.logger.warn(`Google Geocoding API denied request: ${data.error_message ?? ''}`);
        return null;
      }
      if (data.status !== 'OK') {
        this.logger.warn(`Google Geocoding API status ${data.status} for (${lat}, ${lng})`);
        return null;
      }

      const first = data.results[0];
      if (!first) return null;

      const components = first.address_components;
      const get = (type: string, name: 'long_name' | 'short_name') =>
        components.find(c => c.types.includes(type))?.[name];

      return {
        country: get('country', 'long_name'),
        countryCode: get('country', 'short_name'),
        admin1: get('administrative_area_level_1', 'long_name'),
        admin2: get('administrative_area_level_2', 'long_name'),
        locality: get('locality', 'long_name') ?? get('postal_town', 'long_name'),
        placeName: first.formatted_address,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Google Geocoding request failed for (${lat}, ${lng}): ${msg}`);
      return null;
    }
  }
}
