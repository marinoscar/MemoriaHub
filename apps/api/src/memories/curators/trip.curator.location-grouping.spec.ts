/**
 * Location Grouping in Memories trip naming (issue #374).
 *
 * `TripCurator` now tallies the CANONICAL place columns, so a trip spanning
 * "Conroe", "Shenandoah" and "The Woodlands" resolves to one place instead of
 * splitting three ways.
 *
 * The discriminator used here is home inference: `inferHome` needs a modal
 * place holding at least 30% of geocoded items. The fixture below fragments the
 * RAW locality and admin1 columns four ways (18% each) while the CANONICAL
 * columns agree on one name (72%). Tallying raw therefore infers no home at all
 * and the curator returns immediately; tallying canonical infers a home,
 * classifies the away day, and reaches the per-run floor — an outcome only
 * reachable if the canonical columns are what is counted.
 */
import { Test, TestingModule } from '@nestjs/testing';

import { TripCurator } from './trip.curator';
import { MemoryCurationService } from '../curation/memory-curation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const CIRCLE_ID = 'circle-trip-lg';
const NOW = new Date('2026-08-10T00:00:00.000Z');

const HOME = { lat: 10.0, lng: -84.0 };
const AWAY = { lat: 40.0, lng: -3.0 };

/** Four distinct raw spellings, so no single raw value can clear the 30% floor. */
const RAW_HOME_SPELLINGS = [
  { locality: 'Heredia', admin1: 'Heredia' },
  { locality: 'Heredia Centro', admin1: 'Heredia Province' },
  { locality: 'San Francisco', admin1: 'Provincia de Heredia' },
  { locality: 'Ulloa', admin1: 'Prov. Heredia' },
];

function day(offset: number): Date {
  return new Date(NOW.getTime() - offset * 24 * 3600 * 1000);
}

/**
 * @param canonicalCollapses when true the canonical columns agree on one name
 *   (the real post-grouping state); when false they mirror the fragmented raw
 *   values (the pre-grouping / no-groups state).
 */
function makeRows(canonicalCollapses: boolean) {
  const rows: Array<Record<string, unknown>> = [];

  // 8 home photos over 8 distinct days, cycling the four raw spellings.
  for (let i = 0; i < 8; i++) {
    const raw = RAW_HOME_SPELLINGS[i % RAW_HOME_SPELLINGS.length];
    rows.push({
      id: `home-${i}`,
      capturedAt: day(40 + i),
      takenLat: HOME.lat,
      takenLng: HOME.lng,
      geoLocality: raw.locality,
      geoAdmin1: raw.admin1,
      geoCountry: 'Costa Rica',
      geoCanonicalLocality: canonicalCollapses ? 'Heredia' : raw.locality,
      geoCanonicalAdmin1: canonicalCollapses ? 'Heredia' : raw.admin1,
      geoCanonicalCountry: 'Costa Rica',
    });
  }

  // 3 away photos on one day — enough to form a single away run.
  for (let i = 0; i < 3; i++) {
    rows.push({
      id: `away-${i}`,
      capturedAt: day(10),
      takenLat: AWAY.lat,
      takenLng: AWAY.lng,
      geoLocality: 'Madrid',
      geoAdmin1: 'Madrid Region',
      geoCountry: 'Spain',
      geoCanonicalLocality: 'Madrid',
      geoCanonicalAdmin1: 'Madrid Region',
      geoCanonicalCountry: 'Spain',
    });
  }

  return rows;
}

function makeContext() {
  return {
    circleId: CIRCLE_ID,
    now: NOW,
    backfill: false,
    settings: {
      trips: {
        enabled: true,
        minDays: 1,
        // Deliberately unreachable: the run is counted as `skipped` before
        // `curateRun` (and the curation service) is ever touched, which keeps
        // this spec focused on the place tally.
        minItems: 1_000,
        minDistanceKm: 50,
        lookbackMonths: 18,
      },
    },
  } as any;
}

describe('TripCurator — canonical place tallies (issue #374)', () => {
  let curator: TripCurator;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripCurator,
        { provide: PrismaService, useValue: prisma },
        { provide: MemoryCurationService, useValue: {} },
      ],
    }).compile();

    curator = module.get(TripCurator);
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('selects the canonical columns alongside the raw ones', async () => {
    (prisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

    await curator.run(makeContext());

    const [call] = (prisma.mediaItem.findMany as jest.Mock).mock.calls;
    expect(call[0].select).toMatchObject({
      geoLocality: true,
      geoAdmin1: true,
      geoCountry: true,
      geoCanonicalLocality: true,
      geoCanonicalAdmin1: true,
      geoCanonicalCountry: true,
    });
  });

  it('infers a home from the COLLAPSED canonical names and reaches the away run', async () => {
    (prisma.mediaItem.findMany as jest.Mock).mockResolvedValue(makeRows(true));

    const result = await curator.run(makeContext());

    // Home inferred ⇒ the away day is classified, merged into one run, and
    // skipped only by the deliberately-unreachable minItems floor.
    expect(result.skipped).toBe(1);
    expect(prisma.memory.findMany).toHaveBeenCalled();
  });

  it('infers NO home when the same library is left fragmented across raw spellings', async () => {
    // The control: identical coordinates and dates, only the canonical columns
    // differ. Four spellings at 18% each never clear the 30% modal floor, so the
    // curator bails before classifying a single day.
    (prisma.mediaItem.findMany as jest.Mock).mockResolvedValue(makeRows(false));

    const result = await curator.run(makeContext());

    expect(result).toEqual({ created: 0, refreshed: 0, skipped: 0, tombstoned: 0 });
    expect(prisma.memory.findMany).not.toHaveBeenCalled();
  });
});
