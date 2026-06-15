import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ForwardGeocodeService } from './forward-geocode.service';

// ---------------------------------------------------------------------------
// Helper: build a minimal fetch Response mock
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

  async function buildService(enabled: string): Promise<ForwardGeocodeService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ForwardGeocodeService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'GEO_FORWARD_SEARCH_ENABLED') return enabled;
              if (key === 'NOMINATIM_BASE_URL')
                return 'https://nominatim.openstreetmap.org';
              return defaultValue ?? undefined;
            }),
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
});
