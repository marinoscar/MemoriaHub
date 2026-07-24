/**
 * Unit tests for LocationInferenceService.
 *
 * Covers:
 *  - haversineKm golden values
 *  - computeLocationSuggestion matrix: anchor selection, interpolation golden
 *    values, antimeridian wrap, disagreement fallback, speed-gate matrix,
 *    extrapolation gating, auto-apply gate matrix
 *  - inferForItem: eligibility guards, rejected-skip vs forceRerun, device
 *    filter, drift-prevention anchor query rule, applyComputedSuggestion
 *    effects (auto-apply vs pending)
 *  - sweepCircle: two-pointer walk, anchors outside [from,to] still anchor
 *    targets inside, snapshot invariant (no in-sweep chaining), force
 *    semantics, chunked writes, cross-device pass 2
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, LocationSuggestionStatus, MediaType } from '@prisma/client';
import {
  AnchorPoint,
  ComputedLocationSuggestion,
  computeLocationSuggestion,
  haversineKm,
  LocationInferenceConfig,
  LocationInferenceService,
} from './location-inference.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CFG: LocationInferenceConfig = {
  maxGapMinutes: 30,
  maxExtrapolationGapMinutes: 10,
  autoApplyMaxGapMinutes: 5,
  requireSameDevice: true,
  maxAnchorDistanceKm: 2,
  maxImpliedSpeedKmh: 150,
  bulkAcceptThreshold: 80,
};

function makeCfg(overrides: Partial<LocationInferenceConfig> = {}): LocationInferenceConfig {
  return { ...DEFAULT_CFG, ...overrides };
}

function makeAnchor(overrides: Partial<AnchorPoint> = {}): AnchorPoint {
  return {
    id: 'anchor-1',
    capturedAt: new Date('2026-01-01T00:00:00.000Z'),
    lat: 10,
    lng: 20,
    ...overrides,
  };
}

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

// ---------------------------------------------------------------------------
// haversineKm
// ---------------------------------------------------------------------------

describe('haversineKm', () => {
  it('returns 0 for identical points', () => {
    expect(haversineKm(0, 0, 0, 0)).toBe(0);
  });

  it('returns ~half the Earth circumference (R*pi) for antipodal points on the equator', () => {
    expect(haversineKm(0, 0, 0, 180)).toBeCloseTo(20015.09, 1);
  });

  it('returns ~a quarter of the Earth circumference (R*pi/2) equator-to-pole', () => {
    expect(haversineKm(0, 0, 90, 0)).toBeCloseTo(10007.5, 0);
  });

  it('returns a small plausible distance for two nearby points in San Jose, CR', () => {
    const d = haversineKm(9.9281, -84.0907, 9.9333, -84.0833);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(15);
  });
});

// ---------------------------------------------------------------------------
// computeLocationSuggestion
// ---------------------------------------------------------------------------

describe('computeLocationSuggestion', () => {
  describe('anchor selection', () => {
    it('before-only -> method "nearest", anchorAfterId null, autoApplyEligible always false', () => {
      const cfg = makeCfg();
      const target = new Date(T0 + 5 * 60_000);
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 1, lng: 2 });

      const result = computeLocationSuggestion(target, anchorBefore, null, cfg, true);

      expect(result).not.toBeNull();
      expect(result!.method).toBe('nearest');
      expect(result!.anchorBeforeId).toBe('before-1');
      expect(result!.anchorAfterId).toBeNull();
      expect(result!.autoApplyEligible).toBe(false);
    });

    it('after-only -> method "nearest", anchorBeforeId null, autoApplyEligible always false', () => {
      const cfg = makeCfg();
      const target = new Date(T0);
      const anchorAfter = makeAnchor({ id: 'after-1', capturedAt: new Date(T0 + 5 * 60_000), lat: 1, lng: 2 });

      const result = computeLocationSuggestion(target, null, anchorAfter, cfg, true);

      expect(result).not.toBeNull();
      expect(result!.method).toBe('nearest');
      expect(result!.anchorAfterId).toBe('after-1');
      expect(result!.anchorBeforeId).toBeNull();
      expect(result!.autoApplyEligible).toBe(false);
    });

    it('both anchors present -> method "interpolated"', () => {
      const cfg = makeCfg();
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0) });
      const anchorAfter = makeAnchor({ id: 'after-1', capturedAt: new Date(T0 + 10 * 60_000) });
      const target = new Date(T0 + 5 * 60_000);

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, true);

      expect(result).not.toBeNull();
      expect(result!.method).toBe('interpolated');
    });

    it('neither anchor -> returns null', () => {
      const cfg = makeCfg();
      const result = computeLocationSuggestion(new Date(T0), null, null, cfg, true);
      expect(result).toBeNull();
    });
  });

  describe('interpolation golden values', () => {
    it('time-weights lat/lng between two agreeing anchors at the midpoint (w=0.5)', () => {
      // Override maxAnchorDistanceKm so these two anchors (~15.6km apart) agree —
      // production default (2km) would trigger the disagreement fallback instead.
      const cfg = makeCfg({ maxAnchorDistanceKm: 20 });
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 10, lng: 20 });
      const anchorAfter = makeAnchor({
        id: 'after-1',
        capturedAt: new Date(T0 + 10 * 60_000),
        lat: 10.1,
        lng: 20.1,
      });
      const target = new Date(T0 + 5 * 60_000);

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, false);

      expect(result).not.toBeNull();
      expect(result!.lat).toBeCloseTo(10.05, 6);
      expect(result!.lng).toBeCloseTo(20.05, 6);
      expect(result!.gapBeforeSeconds).toBe(300);
      expect(result!.gapAfterSeconds).toBe(300);

      const expectedD = haversineKm(10, 20, 10.1, 20.1);
      expect(result!.anchorDistanceKm).toBeCloseTo(expectedD, 10);

      const expectedSpeed = expectedD / (600 / 3600);
      expect(result!.impliedSpeedKmh).toBeCloseTo(expectedSpeed, 6);
    });
  });

  describe('antimeridian wrap', () => {
    it('wraps longitude near +/-180 instead of interpolating through 0', () => {
      const cfg = makeCfg({ maxAnchorDistanceKm: 300 });
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 0, lng: 179 });
      const anchorAfter = makeAnchor({
        id: 'after-1',
        capturedAt: new Date(T0 + 2 * 60_000),
        lat: 0,
        lng: -179,
      });
      const target = new Date(T0 + 60_000); // midpoint, w=0.5

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, false);

      expect(result).not.toBeNull();
      expect(Math.abs(Math.abs(result!.lng) - 180)).toBeLessThan(1);
    });

    it('control: normal (non-wrapping) interpolation is unaffected by the wrap logic', () => {
      const cfg = makeCfg({ maxAnchorDistanceKm: 500 });
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 0, lng: -70 });
      const anchorAfter = makeAnchor({
        id: 'after-1',
        capturedAt: new Date(T0 + 2 * 60_000),
        lat: 0,
        lng: -74,
      });
      const target = new Date(T0 + 60_000); // midpoint, w=0.5

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, false);

      expect(result).not.toBeNull();
      expect(result!.lng).toBeCloseTo(-72, 6);
    });
  });

  describe('disagreement fallback', () => {
    it('anchors farther apart than maxAnchorDistanceKm fall back to the nearer-in-time anchor raw coords', () => {
      const cfg = makeCfg(); // default maxAnchorDistanceKm = 2km; D here ~15.6km
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 10, lng: 20 });
      const anchorAfter = makeAnchor({
        id: 'after-1',
        capturedAt: new Date(T0 + 10 * 60_000),
        lat: 10.1,
        lng: 20.1,
      });
      // target closer to "before" (gapBefore=180s <= gapAfter=420s) -> useBefore
      const target = new Date(T0 + 3 * 60_000);

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, false);

      expect(result).not.toBeNull();
      expect(result!.method).toBe('interpolated');
      expect(result!.lat).toBe(10);
      expect(result!.lng).toBe(20);
      expect(result!.confidence).toBeLessThanOrEqual(0.5);
    });
  });

  describe('speed-gate matrix', () => {
    it('(a) zero gap on both sides -> impliedSpeedKmh is exactly 0, not NaN/Infinity', () => {
      const cfg = makeCfg();
      const sameTime = new Date(T0);
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: sameTime, lat: 10, lng: 20 });
      const anchorAfter = makeAnchor({ id: 'after-1', capturedAt: sameTime, lat: 10, lng: 20 });

      const result = computeLocationSuggestion(sameTime, anchorBefore, anchorAfter, cfg, true);

      expect(result).not.toBeNull();
      expect(result!.gapBeforeSeconds).toBe(0);
      expect(result!.gapAfterSeconds).toBe(0);
      expect(result!.impliedSpeedKmh).toBe(0);
      expect(Number.isFinite(result!.impliedSpeedKmh)).toBe(true);
    });

    it('(b) speed exceeding maxImpliedSpeedKmh caps confidence <= 0.4 and forces autoApplyEligible=false', () => {
      const cfg = makeCfg(); // maxImpliedSpeedKmh = 150
      // ~1.11km covered in 10 seconds => ~400 km/h, agree (D<2km), gaps tiny (<=5min)
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 0, lng: 0 });
      const anchorAfter = makeAnchor({
        id: 'after-1',
        capturedAt: new Date(T0 + 10_000),
        lat: 0.01,
        lng: 0,
      });
      const target = new Date(T0 + 5_000); // midpoint

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, true);

      expect(result).not.toBeNull();
      expect(result!.impliedSpeedKmh).toBeGreaterThan(cfg.maxImpliedSpeedKmh);
      expect(result!.confidence).toBeLessThanOrEqual(0.4);
      expect(result!.autoApplyEligible).toBe(false);
    });

    it('(c) speed exactly AT the threshold does NOT trigger the speed-exceeded confidence cap (strict >)', () => {
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 0, lng: 0 });
      const anchorAfter = makeAnchor({
        id: 'after-1',
        capturedAt: new Date(T0 + 60_000),
        lat: 0.001,
        lng: 0,
      });
      const target = new Date(T0 + 30_000); // midpoint: gapBefore=gapAfter=30s

      const D = haversineKm(0, 0, 0.001, 0);
      const gapHours = 60 / 3600;
      const exactSpeed = D / gapHours;
      const cfg = makeCfg({ maxImpliedSpeedKmh: exactSpeed, maxAnchorDistanceKm: 2 });

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, true);

      expect(result).not.toBeNull();
      expect(result!.impliedSpeedKmh).toBeCloseTo(cfg.maxImpliedSpeedKmh, 8);
      // Not capped to <=0.4 by the speed-exceeded branch (strict > means equal speed does not exceed).
      expect(result!.confidence).toBeGreaterThan(0.4);
    });
  });

  describe('extrapolation gating (single anchor)', () => {
    it('gapMinutes exactly at maxExtrapolationGapMinutes still returns a suggestion (boundary is >, not >=)', () => {
      const cfg = makeCfg({ maxExtrapolationGapMinutes: 10 });
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0) });
      const target = new Date(T0 + 10 * 60_000); // exactly 10 minutes

      const result = computeLocationSuggestion(target, anchorBefore, null, cfg, true);

      expect(result).not.toBeNull();
    });

    it('gapMinutes one unit past maxExtrapolationGapMinutes returns null', () => {
      const cfg = makeCfg({ maxExtrapolationGapMinutes: 10 });
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0) });
      const target = new Date(T0 + 10 * 60_000 + 1_000); // 10min + 1s

      const result = computeLocationSuggestion(target, anchorBefore, null, cfg, true);

      expect(result).toBeNull();
    });

    it('single-anchor confidence matches the hand-derived formula', () => {
      const cfg = makeCfg({ maxGapMinutes: 30, maxExtrapolationGapMinutes: 10 });
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0) });
      const target = new Date(T0 + 5 * 60_000); // gapMinutes = 5

      const result = computeLocationSuggestion(target, anchorBefore, null, cfg, true);

      // confidence = clamp01(0.5*timeFactor + 0.3*0.25 + 0.2*0.5), timeFactor = 1 - 5/30
      const timeFactor = 1 - 5 / 30;
      const expected = 0.5 * timeFactor + 0.3 * 0.25 + 0.2 * 0.5;
      expect(result).not.toBeNull();
      expect(result!.confidence).toBeCloseTo(expected, 6);
    });
  });

  describe('auto-apply gate matrix (two-anchor case only)', () => {
    function baselineAnchors() {
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 0, lng: 0 });
      const anchorAfter = makeAnchor({
        id: 'after-1',
        capturedAt: new Date(T0 + 120_000), // 2 min gap
        lat: 0,
        lng: 0,
      });
      const target = new Date(T0 + 60_000); // midpoint: 1min each side
      return { anchorBefore, anchorAfter, target };
    }

    it('baseline: deviceMatchGuaranteed=true, tight gaps, agreeing anchors, no speed excess -> autoApplyEligible=true', () => {
      const cfg = makeCfg({ autoApplyMaxGapMinutes: 5 });
      const { anchorBefore, anchorAfter, target } = baselineAnchors();

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, true);

      expect(result).not.toBeNull();
      expect(result!.autoApplyEligible).toBe(true);
    });

    it('flips false when deviceMatchGuaranteed=false', () => {
      const cfg = makeCfg({ autoApplyMaxGapMinutes: 5 });
      const { anchorBefore, anchorAfter, target } = baselineAnchors();

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, false);

      expect(result!.autoApplyEligible).toBe(false);
    });

    it('flips false when a gap exceeds autoApplyMaxGapMinutes', () => {
      const cfg = makeCfg({ autoApplyMaxGapMinutes: 5 });
      // Push anchorBefore back so gapBefore = 400s (6.67min) > 5min
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0 - 400_000), lat: 0, lng: 0 });
      const anchorAfter = makeAnchor({ id: 'after-1', capturedAt: new Date(T0 + 60_000), lat: 0, lng: 0 });
      const target = new Date(T0);

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, true);

      expect(result!.gapBeforeSeconds! / 60).toBeGreaterThan(cfg.autoApplyMaxGapMinutes);
      expect(result!.autoApplyEligible).toBe(false);
    });

    it('flips false when anchors disagree (D > maxAnchorDistanceKm)', () => {
      const cfg = makeCfg({ autoApplyMaxGapMinutes: 5, maxAnchorDistanceKm: 2 });
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 10, lng: 20 });
      const anchorAfter = makeAnchor({
        id: 'after-1',
        capturedAt: new Date(T0 + 60_000),
        lat: 10.1, // ~15.6km away -> disagree
        lng: 20.1,
      });
      const target = new Date(T0 + 30_000);

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, true);

      expect(result!.autoApplyEligible).toBe(false);
    });

    it('flips false when implied speed exceeds maxImpliedSpeedKmh', () => {
      const cfg = makeCfg({ autoApplyMaxGapMinutes: 5, maxAnchorDistanceKm: 2, maxImpliedSpeedKmh: 150 });
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 0, lng: 0 });
      const anchorAfter = makeAnchor({
        id: 'after-1',
        capturedAt: new Date(T0 + 10_000),
        lat: 0.01, // ~1.11km in 10s -> ~400km/h, exceeds 150
        lng: 0,
      });
      const target = new Date(T0 + 5_000);

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, true);

      expect(result!.autoApplyEligible).toBe(false);
    });

    it('autoApplyMaxGapMinutes=0 disables auto-apply entirely even with a tiny 1-second gap', () => {
      const cfg = makeCfg({ autoApplyMaxGapMinutes: 0 });
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0), lat: 0, lng: 0 });
      const anchorAfter = makeAnchor({ id: 'after-1', capturedAt: new Date(T0 + 2_000), lat: 0, lng: 0 });
      const target = new Date(T0 + 1_000); // gapBefore=gapAfter=1s

      const result = computeLocationSuggestion(target, anchorBefore, anchorAfter, cfg, true);

      expect(result!.autoApplyEligible).toBe(false);
    });

    it('single-anchor case never auto-applies regardless of deviceMatchGuaranteed', () => {
      const cfg = makeCfg();
      const anchorBefore = makeAnchor({ id: 'before-1', capturedAt: new Date(T0) });
      const target = new Date(T0 + 60_000);

      const result = computeLocationSuggestion(target, anchorBefore, null, cfg, true);

      expect(result!.autoApplyEligible).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// LocationInferenceService — inferForItem / applyComputedSuggestion
// ---------------------------------------------------------------------------

describe('LocationInferenceService', () => {
  let service: LocationInferenceService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock };

  const CIRCLE_ID = 'circle-1';
  const MEDIA_ID = 'media-1';

  function setCfg(cfg: Partial<LocationInferenceConfig> = {}) {
    mockSystemSettings.getSettings.mockResolvedValue({ locationInference: makeCfg(cfg) });
  }

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }) };
    mockSystemSettings = { getSettings: jest.fn() };
    setCfg();

    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationInferenceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
      ],
    }).compile();

    service = module.get<LocationInferenceService>(LocationInferenceService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function makeItem(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: MEDIA_ID,
      type: MediaType.photo,
      deletedAt: null,
      circleId: CIRCLE_ID,
      takenLat: null,
      capturedAt: new Date(T0),
      cameraMake: 'Canon',
      cameraModel: 'R5',
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // inferForItem — eligibility no-ops
  // -------------------------------------------------------------------------

  describe('inferForItem no-ops', () => {
    it('no-ops when the item is not found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.locationSuggestion.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('no-ops when the item is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem({ deletedAt: new Date() }));

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.locationSuggestion.upsert).not.toHaveBeenCalled();
    });

    it('no-ops when the item is not a photo', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem({ type: MediaType.video }));

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.locationSuggestion.upsert).not.toHaveBeenCalled();
    });

    it('no-ops when the item already has GPS (takenLat !== null)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem({ takenLat: 10 }));

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.locationSuggestion.upsert).not.toHaveBeenCalled();
    });

    it('no-ops when capturedAt is null', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem({ capturedAt: null }));

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.locationSuggestion.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // rejected-skip vs forceRerun
  // -------------------------------------------------------------------------

  describe('rejected-suggestion skip vs forceRerun', () => {
    it('forceRerun=false + existing rejected suggestion -> returns early without querying anchors', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue({
        status: LocationSuggestionStatus.rejected,
      });

      await service.inferForItem(MEDIA_ID, false);

      expect(mockPrisma.mediaItem.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.locationSuggestion.upsert).not.toHaveBeenCalled();
    });

    it('forceRerun=true + existing rejected suggestion -> proceeds to query anchors', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue({
        status: LocationSuggestionStatus.rejected,
      });
      (mockPrisma.mediaItem.findFirst as jest.Mock).mockResolvedValue(null);

      await service.inferForItem(MEDIA_ID, true);

      expect(mockPrisma.mediaItem.findFirst).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Device requirement
  // -------------------------------------------------------------------------

  describe('requireSameDevice gate', () => {
    it('no-ops when requireSameDevice=true and item has neither cameraMake nor cameraModel', async () => {
      setCfg({ requireSameDevice: true });
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeItem({ cameraMake: null, cameraModel: null }),
      );

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.mediaItem.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.locationSuggestion.upsert).not.toHaveBeenCalled();
    });

    it('proceeds when requireSameDevice=false even with no camera info; deviceFilter is {} and the write is always pending (never auto-applies cross-device)', async () => {
      setCfg({ requireSameDevice: false, autoApplyMaxGapMinutes: 5, maxAnchorDistanceKm: 2, maxImpliedSpeedKmh: 150 });
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeItem({ cameraMake: null, cameraModel: null }),
      );

      const anchorBeforeRow = {
        id: 'anchor-before',
        capturedAt: new Date(T0 - 60_000),
        takenLat: 0,
        takenLng: 0,
      };
      const anchorAfterRow = {
        id: 'anchor-after',
        capturedAt: new Date(T0 + 60_000),
        takenLat: 0,
        takenLng: 0,
      };
      (mockPrisma.mediaItem.findFirst as jest.Mock)
        .mockResolvedValueOnce(anchorBeforeRow)
        .mockResolvedValueOnce(anchorAfterRow);

      await service.inferForItem(MEDIA_ID);

      const [beforeCall, afterCall] = (mockPrisma.mediaItem.findFirst as jest.Mock).mock.calls;
      expect(beforeCall[0].where).not.toHaveProperty('cameraMake');
      expect(beforeCall[0].where).not.toHaveProperty('cameraModel');
      expect(afterCall[0].where).not.toHaveProperty('cameraMake');
      expect(afterCall[0].where).not.toHaveProperty('cameraModel');

      // Even though gaps/distance/speed would otherwise qualify for auto-apply,
      // requireSameDevice=false means deviceMatchGuaranteed=false, so the
      // write must be 'pending', never 'auto_applied'.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.locationSuggestion.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: LocationSuggestionStatus.pending }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Drift-prevention anchor query rule
  // -------------------------------------------------------------------------

  describe('anchor query drift-prevention rule', () => {
    it('both the before and after anchor queries filter coordSource to [exif, manual]', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.mediaItem.findFirst as jest.Mock).mockResolvedValue(null);

      await service.inferForItem(MEDIA_ID);

      const [beforeCall, afterCall] = (mockPrisma.mediaItem.findFirst as jest.Mock).mock.calls;
      expect(beforeCall[0].where.coordSource).toEqual({ in: ['exif', 'manual'] });
      expect(afterCall[0].where.coordSource).toEqual({ in: ['exif', 'manual'] });
    });
  });

  // -------------------------------------------------------------------------
  // Anchor selection end-to-end
  // -------------------------------------------------------------------------

  describe('anchor selection end-to-end', () => {
    it('before-row only -> writes a suggestion', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.mediaItem.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'anchor-b', capturedAt: new Date(T0 - 60_000), takenLat: 1, takenLng: 2 })
        .mockResolvedValueOnce(null);

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.locationSuggestion.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { mediaItemId: MEDIA_ID } }),
      );
    });

    it('after-row only -> writes a suggestion', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.mediaItem.findFirst as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'anchor-a', capturedAt: new Date(T0 + 60_000), takenLat: 1, takenLng: 2 });

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.locationSuggestion.upsert).toHaveBeenCalled();
    });

    it('both rows -> writes a suggestion', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.mediaItem.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'anchor-b', capturedAt: new Date(T0 - 60_000), takenLat: 1, takenLng: 2 })
        .mockResolvedValueOnce({ id: 'anchor-a', capturedAt: new Date(T0 + 60_000), takenLat: 1.001, takenLng: 2.001 });

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.locationSuggestion.upsert).toHaveBeenCalled();
    });

    it('neither row -> no suggestion written', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.mediaItem.findFirst as jest.Mock).mockResolvedValue(null);

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.locationSuggestion.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // applyComputedSuggestion effects
  // -------------------------------------------------------------------------

  describe('applyComputedSuggestion effects', () => {
    it('auto-apply path: writes coords + suggestion + audit event in one transaction, then enqueues geocode', async () => {
      setCfg({ autoApplyMaxGapMinutes: 5, maxAnchorDistanceKm: 2, maxImpliedSpeedKmh: 150 });
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      const anchorBeforeRow = { id: 'anchor-b', capturedAt: new Date(T0 - 60_000), takenLat: 0, takenLng: 0 };
      const anchorAfterRow = { id: 'anchor-a', capturedAt: new Date(T0 + 60_000), takenLat: 0, takenLng: 0 };
      (mockPrisma.mediaItem.findFirst as jest.Mock)
        .mockResolvedValueOnce(anchorBeforeRow)
        .mockResolvedValueOnce(anchorAfterRow);

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: MEDIA_ID },
          data: expect.objectContaining({ takenLat: 0, takenLng: 0, coordSource: 'inferred' }),
        }),
      );
      expect(mockPrisma.locationSuggestion.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: LocationSuggestionStatus.auto_applied }),
        }),
      );
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: null,
            action: 'media:location_inferred',
            targetType: 'media_item',
            targetId: MEDIA_ID,
          }),
        }),
      );
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: 'geocode',
        mediaItemId: MEDIA_ID,
        circleId: CIRCLE_ID,
        reason: JobReason.rerun,
        priority: 0,
      });
    });

    it('pending path: writes only the suggestion (status pending); no transaction, no geocode enqueue', async () => {
      setCfg({ autoApplyMaxGapMinutes: 5, maxAnchorDistanceKm: 2, maxImpliedSpeedKmh: 150 });
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      // Single anchor -> never auto-applies.
      (mockPrisma.mediaItem.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'anchor-b', capturedAt: new Date(T0 - 60_000), takenLat: 0, takenLng: 0 })
        .mockResolvedValueOnce(null);

      await service.inferForItem(MEDIA_ID);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.locationSuggestion.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: LocationSuggestionStatus.pending }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // sweepCircle
  // -------------------------------------------------------------------------

  describe('sweepCircle', () => {
    function baseSweepMocks() {
      (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.locationSuggestion.createMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.locationSuggestion.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.auditEvent.createMany as jest.Mock).mockResolvedValue({ count: 0 });
    }

    it('device grouping / two-pointer walk: interpolates a GPS-less target between two same-device anchors', async () => {
      baseSweepMocks();
      const rows = [
        {
          id: 'r1',
          capturedAt: new Date(T0),
          cameraMake: 'Canon',
          cameraModel: 'R5',
          takenLat: 10,
          takenLng: 20,
          coordSource: 'exif',
        },
        {
          id: 'r2',
          capturedAt: new Date(T0 + 5 * 60_000),
          cameraMake: 'Canon',
          cameraModel: 'R5',
          takenLat: null,
          takenLng: null,
          coordSource: null,
        },
        {
          id: 'r3',
          capturedAt: new Date(T0 + 10 * 60_000),
          cameraMake: 'Canon',
          cameraModel: 'R5',
          takenLat: 10.001,
          takenLng: 20.001,
          coordSource: 'exif',
        },
      ];
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(rows);

      const result = await service.sweepCircle(CIRCLE_ID, {});

      expect(result.targets).toBe(1);
      const createManyCall = (mockPrisma.locationSuggestion.createMany as jest.Mock).mock.calls[0][0];
      const r2Data = createManyCall.data.find((d: any) => d.mediaItemId === 'r2');
      expect(r2Data).toBeDefined();
      expect(r2Data.lat).toBeCloseTo(10.0005, 6);
      expect(r2Data.lng).toBeCloseTo(20.0005, 6);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('an anchor outside [from,to] still anchors a target inside the window', async () => {
      baseSweepMocks();
      const cfgOverride = { maxGapMinutes: 120, maxExtrapolationGapMinutes: 120 };
      setCfg(cfgOverride);

      const anchorRow = {
        id: 'anchor-outside',
        capturedAt: new Date('2026-01-09T23:00:00.000Z'), // before `from`
        cameraMake: 'X',
        cameraModel: 'Y',
        takenLat: 5,
        takenLng: 5,
        coordSource: 'exif',
      };
      const targetRow = {
        id: 'target-inside',
        capturedAt: new Date('2026-01-10T00:30:00.000Z'), // inside [from,to]
        cameraMake: 'X',
        cameraModel: 'Y',
        takenLat: null,
        takenLng: null,
        coordSource: null,
      };
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([anchorRow, targetRow]);

      const result = await service.sweepCircle(CIRCLE_ID, {
        from: '2026-01-10T00:00:00.000Z',
        to: '2026-01-20T00:00:00.000Z',
      });

      expect(result.targets).toBe(1);
      const createManyCall = (mockPrisma.locationSuggestion.createMany as jest.Mock).mock.calls[0][0];
      const targetData = createManyCall.data.find((d: any) => d.mediaItemId === 'target-inside');
      expect(targetData).toBeDefined();
      expect(targetData.anchorBeforeId).toBe('anchor-outside');
    });

    it('snapshot invariant: a target auto-applied earlier in the walk never anchors a later target in the same sweep', async () => {
      baseSweepMocks();
      // A (real anchor, exif) -> B (GPS-less target) -> C (GPS-less target)
      const rowA = {
        id: 'item-a',
        capturedAt: new Date(T0),
        cameraMake: 'Canon',
        cameraModel: 'R5',
        takenLat: 0,
        takenLng: 0,
        coordSource: 'exif',
      };
      const rowB = {
        id: 'item-b',
        capturedAt: new Date(T0 + 5 * 60_000),
        cameraMake: 'Canon',
        cameraModel: 'R5',
        takenLat: null,
        takenLng: null,
        coordSource: null,
      };
      const rowC = {
        id: 'item-c',
        capturedAt: new Date(T0 + 10 * 60_000),
        cameraMake: 'Canon',
        cameraModel: 'R5',
        takenLat: null,
        takenLng: null,
        coordSource: null,
      };
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([rowA, rowB, rowC]);

      await service.sweepCircle(CIRCLE_ID, {});

      const createManyCall = (mockPrisma.locationSuggestion.createMany as jest.Mock).mock.calls[0][0];
      const cData = createManyCall.data.find((d: any) => d.mediaItemId === 'item-c');
      expect(cData).toBeDefined();
      // C must be anchored on A (the real anchor), NEVER on B (a target, even if
      // auto-applied within this same walk) — proving results are computed
      // entirely from the pre-loaded snapshot, not from in-flight writes.
      expect(cData.anchorBeforeId).toBe('item-a');
      expect(cData.anchorBeforeId).not.toBe('item-b');
    });

    describe('force semantics', () => {
      it('force=false excludes a target that already has ANY existing suggestion (pending or rejected)', async () => {
        baseSweepMocks();
        const anchorRow = {
          id: 'anchor-1',
          capturedAt: new Date(T0),
          cameraMake: 'Canon',
          cameraModel: 'R5',
          takenLat: 0,
          takenLng: 0,
          coordSource: 'exif',
        };
        const targetRow = {
          id: 'target-existing',
          capturedAt: new Date(T0 + 60_000),
          cameraMake: 'Canon',
          cameraModel: 'R5',
          takenLat: null,
          takenLng: null,
          coordSource: null,
        };
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([anchorRow, targetRow]);
        (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([
          { mediaItemId: 'target-existing' },
        ]);

        const result = await service.sweepCircle(CIRCLE_ID, { force: false });

        expect(result.targets).toBe(0);
        expect(mockPrisma.locationSuggestion.createMany).not.toHaveBeenCalled();
      });

      it('force=true re-includes previously-excluded targets and clears both pending AND rejected rows', async () => {
        baseSweepMocks();
        const anchorRow = {
          id: 'anchor-1',
          capturedAt: new Date(T0),
          cameraMake: 'Canon',
          cameraModel: 'R5',
          takenLat: 0,
          takenLng: 0,
          coordSource: 'exif',
        };
        const targetRow = {
          id: 'target-existing',
          capturedAt: new Date(T0 + 60_000),
          cameraMake: 'Canon',
          cameraModel: 'R5',
          takenLat: null,
          takenLng: null,
          coordSource: null,
        };
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([anchorRow, targetRow]);

        const result = await service.sweepCircle(CIRCLE_ID, { force: true });

        expect(result.targets).toBe(1);
        // force=true bypasses the existingSuggestionIds query entirely.
        expect(mockPrisma.locationSuggestion.findMany).not.toHaveBeenCalled();
        expect(mockPrisma.locationSuggestion.deleteMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              status: { in: [LocationSuggestionStatus.pending, LocationSuggestionStatus.rejected] },
            }),
          }),
        );
      });
    });

    it('chunked writes: >500 eligible targets are written across multiple 500-item transactions', async () => {
      baseSweepMocks();
      const numTargets = 501;
      const rows: Array<Record<string, unknown>> = [];
      for (let i = 0; i <= numTargets; i++) {
        rows.push({
          id: `anchor-${i}`,
          capturedAt: new Date(T0 + i * 2 * 60_000),
          cameraMake: 'Canon',
          cameraModel: 'R5',
          takenLat: 0,
          takenLng: 0,
          coordSource: 'exif',
        });
        if (i < numTargets) {
          rows.push({
            id: `target-${i}`,
            capturedAt: new Date(T0 + i * 2 * 60_000 + 60_000),
            cameraMake: 'Canon',
            cameraModel: 'R5',
            takenLat: null,
            takenLng: null,
            coordSource: null,
          });
        }
      }
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(rows);

      const result = await service.sweepCircle(CIRCLE_ID, {});

      expect(result.targets).toBe(numTargets);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2); // ceil(501/500)
      expect(result.autoApplied).toBe(numTargets);
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(numTargets);
    }, 30000);

    describe('cross-device pass (requireSameDevice=false only)', () => {
      function crossDeviceRows() {
        const anchorA = {
          id: 'anchor-a1',
          capturedAt: new Date(T0),
          cameraMake: 'Sony',
          cameraModel: 'A7',
          takenLat: 0,
          takenLng: 0,
          coordSource: 'exif',
        };
        const anchorB = {
          id: 'anchor-b1',
          capturedAt: new Date(T0 + 60_000),
          cameraMake: 'Nikon',
          cameraModel: 'Z6',
          takenLat: 5,
          takenLng: 5,
          coordSource: 'exif',
        };
        // Deliberately no device on the target — it has no same-device anchor
        // of its own, so pass 1 (which skips null-device groups entirely) can
        // never handle it. Only pass 2 (cross-device, requireSameDevice=false)
        // can produce a suggestion for it.
        const targetShared = {
          id: 'target-shared',
          capturedAt: new Date(T0 + 2 * 60_000),
          cameraMake: null,
          cameraModel: null,
          takenLat: null,
          takenLng: null,
          coordSource: null,
        };
        // findMany orderBy is [cameraMake, cameraModel, capturedAt] — nulls
        // sort first in Postgres by default (NULLS LAST is not specified),
        // but the array order here only needs to be internally consistent
        // for the mock; the null-device group is skipped in pass 1 regardless
        // of its position.
        return [targetShared, anchorB, anchorA];
      }

      it('requireSameDevice=false: pass 2 links the target across devices (suggestion-only, never auto-apply)', async () => {
        baseSweepMocks();
        setCfg({ requireSameDevice: false });
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(crossDeviceRows());

        const result = await service.sweepCircle(CIRCLE_ID, {});

        expect(result.targets).toBe(1);
        expect(result.autoApplied).toBe(0);
        expect(result.pending).toBe(1);
      });

      it('requireSameDevice=true: pass 2 does not run, so the cross-device-only target gets no suggestion at all', async () => {
        baseSweepMocks();
        setCfg({ requireSameDevice: true });
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(crossDeviceRows());

        const result = await service.sweepCircle(CIRCLE_ID, {});

        expect(result.targets).toBe(0);
      });

      it('pass 2 does not re-handle an id already handled by pass 1', async () => {
        baseSweepMocks();
        setCfg({ requireSameDevice: false });
        // Same-device anchor for target-shared exists too, so pass 1 handles it
        // first; pass 2 (cross-device, sorted by capturedAt only) must skip it.
        const sameDeviceAnchor = {
          id: 'anchor-a1',
          capturedAt: new Date(T0),
          cameraMake: 'Sony',
          cameraModel: 'A7',
          takenLat: 0,
          takenLng: 0,
          coordSource: 'exif',
        };
        const targetShared = {
          id: 'target-shared',
          capturedAt: new Date(T0 + 2 * 60_000),
          cameraMake: 'Sony',
          cameraModel: 'A7',
          takenLat: null,
          takenLng: null,
          coordSource: null,
        };
        const crossDeviceAnchor = {
          id: 'anchor-b1',
          capturedAt: new Date(T0 + 60_000),
          cameraMake: 'Nikon',
          cameraModel: 'Z6',
          takenLat: 5,
          takenLng: 5,
          coordSource: 'exif',
        };
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
          crossDeviceAnchor,
          sameDeviceAnchor,
          targetShared,
        ]);

        await service.sweepCircle(CIRCLE_ID, {});

        const createManyCall = (mockPrisma.locationSuggestion.createMany as jest.Mock).mock.calls[0][0];
        const entries = createManyCall.data.filter((d: any) => d.mediaItemId === 'target-shared');
        expect(entries).toHaveLength(1);
        expect(entries[0].anchorBeforeId).toBe('anchor-a1');
      });
    });
  });
});
