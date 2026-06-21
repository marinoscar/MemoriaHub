import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { ForwardGeocodeService } from './forward-geocode.service';

// ---------------------------------------------------------------------------
// Helper: build a minimal fetch Response mock (Nominatim-style)
// ---------------------------------------------------------------------------
function makeFetchResponse(opts: {
  ok: boolean;
  status?: number;
  json?: unknown;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 503),
    json: jest.fn().mockResolvedValue(opts.json ?? []),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Helper: build a minimal fetch Response mock for Google API responses
// ---------------------------------------------------------------------------
function makeGoogleFetchResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Helper: build service with arbitrary config map
// ---------------------------------------------------------------------------
async function buildServiceWithConfig(
  configMap: Record<string, string | undefined>,
  systemSettingsEnabled?: boolean,
): Promise<ForwardGeocodeService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ForwardGeocodeService,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, defaultValue?: string) => {
            return key in configMap ? configMap[key] : defaultValue;
          }),
        },
      },
      {
        provide: SystemSettingsService,
        useValue: {
          getSettingValue: jest.fn().mockResolvedValue(
            systemSettingsEnabled !== undefined ? systemSettingsEnabled : undefined,
          ),
        },
      },
    ],
  }).compile();

  return module.get<ForwardGeocodeService>(ForwardGeocodeService);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ForwardGeocodeService', () => {
  let service: ForwardGeocodeService;
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    if (fetchSpy) {
      fetchSpy.mockRestore();
    }
    jest.restoreAllMocks();
  });

  /**
   * Build ForwardGeocodeService with getSettingValue returning the parsed boolean
   * (true → enabled, false → disabled). The env var path is bypassed because
   * getSettingValue returns a non-undefined value.
   */
  async function buildService(enabled: string): Promise<ForwardGeocodeService> {
    const enabledBool = enabled === 'true';
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ForwardGeocodeService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'NOMINATIM_BASE_URL')
                return 'https://nominatim.openstreetmap.org';
              return defaultValue ?? undefined;
            }),
          },
        },
        {
          provide: SystemSettingsService,
          useValue: {
            getSettingValue: jest.fn().mockResolvedValue(enabledBool),
          },
        },
      ],
    }).compile();

    return module.get<ForwardGeocodeService>(ForwardGeocodeService);
  }

  describe('when GEO_FORWARD_SEARCH_ENABLED is false', () => {
    beforeEach(async () => {
      service = await buildService('false');
    });

    it('throws ServiceUnavailableException', async () => {
      await expect(service.searchPlaces('La Fortuna', 5)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('when GEO_FORWARD_SEARCH_ENABLED is true', () => {
    beforeEach(async () => {
      service = await buildService('true');
    });

    it('returns [] when Nominatim returns non-OK response', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeFetchResponse({ ok: false, status: 503 }));

      const result = await service.searchPlaces('La Fortuna', 5);

      expect(result).toEqual([]);
    });

    it('maps Nominatim results to {lat, lng, label}', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        makeFetchResponse({
          ok: true,
          json: [{ lat: '9.9', lon: '-84.0', display_name: 'La Fortuna, Costa Rica' }],
        }),
      );

      const result = await service.searchPlaces('La Fortuna', 5);

      expect(result).toEqual([
        { lat: 9.9, lng: -84.0, label: 'La Fortuna, Costa Rica' },
      ]);
    });

    it('filters out results missing lat/lon/display_name', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        makeFetchResponse({
          ok: true,
          json: [
            { lat: '9.9', lon: '-84.0', display_name: 'La Fortuna, Costa Rica' },
            { lon: '-84.0', display_name: 'Incomplete (no lat)' }, // missing lat
            { lat: '10.0', display_name: 'Incomplete (no lon)' },  // missing lon
            { lat: '10.0', lon: '-85.0' },                         // missing display_name
          ],
        }),
      );

      const result = await service.searchPlaces('La Fortuna', 10);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('La Fortuna, Costa Rica');
    });

    it('returns [] when fetch throws', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('Network error'));

      const result = await service.searchPlaces('La Fortuna', 5);

      expect(result).toEqual([]);
    });
  });

  describe('when GEO_FORWARD_PROVIDER is google', () => {
    const googleConfig: Record<string, string> = {
      GEO_FORWARD_PROVIDER: 'google',
      GOOGLE_MAPS_API_KEY: 'test-key',
      NOMINATIM_BASE_URL: 'https://nominatim.openstreetmap.org',
    };

    beforeEach(async () => {
      service = await buildServiceWithConfig(googleConfig, true);
    });

    it('status OK → maps results and respects limit slice', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        makeGoogleFetchResponse({
          status: 'OK',
          results: [
            {
              formatted_address: '123 Main St, San José, CR',
              geometry: { location: { lat: 9.93, lng: -84.08 } },
            },
            {
              formatted_address: 'Other Place',
              geometry: { location: { lat: 10.0, lng: -85.0 } },
            },
          ],
        }),
      );

      const result = await service.searchPlaces('Main St', 1);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ lat: 9.93, lng: -84.08, label: '123 Main St, San José, CR' });

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('maps.googleapis.com');
      expect(calledUrl).toContain('address=Main%20St');
    });

    it('ZERO_RESULTS → returns []', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        makeGoogleFetchResponse({ status: 'ZERO_RESULTS', results: [] }),
      );

      const result = await service.searchPlaces('Nowhere Land', 5);

      expect(result).toEqual([]);
    });

    it('REQUEST_DENIED with error_message → returns [] without throwing', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        makeGoogleFetchResponse({
          status: 'REQUEST_DENIED',
          results: [],
          error_message: 'API key not authorized',
        }),
      );

      await expect(service.searchPlaces('anywhere', 5)).resolves.toEqual([]);
    });

    it('network error → returns []', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('Network failure'));

      const result = await service.searchPlaces('Main St', 5);

      expect(result).toEqual([]);
    });

    it('no GOOGLE_MAPS_API_KEY → falls back to Nominatim', async () => {
      service = await buildServiceWithConfig({
        GEO_FORWARD_PROVIDER: 'google',
        GOOGLE_MAPS_API_KEY: '',
        NOMINATIM_BASE_URL: 'https://nominatim.openstreetmap.org',
      }, true);

      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        makeFetchResponse({
          ok: true,
          json: [{ lat: '9.9', lon: '-84.0', display_name: 'La Fortuna, CR' }],
        }),
      );

      const result = await service.searchPlaces('La Fortuna', 5);

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('nominatim.openstreetmap.org');
      expect(calledUrl).not.toContain('googleapis.com');

      expect(result).toEqual([{ lat: 9.9, lng: -84.0, label: 'La Fortuna, CR' }]);
    });
  });
});
