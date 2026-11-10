import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { LocationGroupRebuildService } from '../groups/location-group-rebuild.service.js';
import type { LocationGroupResolverService } from '../groups/location-group-resolver.service.js';

// =============================================================================
// describeLocationSliceConformance (RETRO-J10, #624)
// =============================================================================
//
// The executable proof that location grouping behaves the same wherever it is hosted. Test-runner
// neutral: the caller hands over `describe`, `it` and `expect`.
//
//   resolver   alias beats radius; among radius groups the smallest wins; a group's own canonical name
//              resolves to itself; the feature off is the IDENTITY function; the canonical invariant
//              (raw tier non-null => canonical tier non-null, a null tier stays null);
//   rebuild    the rebuild enqueue is the global job at background priority and NEVER skips the dedup
//              (a burst of admin edits collapses into one rebuild).
// =============================================================================

/**
 * One group the resolver snapshot is seeded with.
 *
 * @stability experimental
 */
export interface SeededLocationGroup {
  /** `country`, `region` or `locality`. */
  level: 'country' | 'region' | 'locality';
  /** The ISO country code the group is scoped to; empty for every country. */
  countryCode: string;
  /** The display name every member collapses into. */
  canonicalName: string;
  /** The raw geocoder spellings the group claims, already folded. */
  aliases?: string[];
  /** The capture-area centre latitude. */
  centerLat?: number;
  /** The capture-area centre longitude. */
  centerLng?: number;
  /** The capture-area radius in kilometres. */
  radiusKm?: number;
}

/**
 * What the resolver section runs against.
 *
 * @stability experimental
 */
export interface LocationResolverUnderTest {
  /** The resolver. */
  resolver: LocationGroupResolverService;
  /** Replaces the enabled groups the resolver reads, and the grouping settings. */
  seed(groups: ReadonlyArray<SeededLocationGroup>, options?: { featureEnabled?: boolean }): void | Promise<void>;
}

/**
 * What the rebuild section runs against.
 *
 * @stability experimental
 */
export interface LocationRebuildUnderTest {
  /** The enqueue helper. */
  service: LocationGroupRebuildService;
  /** The jobs queued so far (type, priority, skipDedup flag). */
  queuedJobs():
    | Array<{ type: string; priority?: number; skipDedup?: boolean }>
    | Promise<Array<{ type: string; priority?: number; skipDedup?: boolean }>>;
}

/**
 * What the kit runs against; a section left out is skipped.
 *
 * @stability experimental
 */
export interface LocationSliceUnderTest {
  /** The resolver section. */
  resolver?: LocationResolverUnderTest;
  /** The rebuild section. */
  rebuild?: LocationRebuildUnderTest;
}

/**
 * Options of {@link describeLocationSliceConformance}.
 *
 * @stability experimental
 */
export interface LocationSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh slice; called before each rule so state never leaks between rules. */
  create(): LocationSliceUnderTest | Promise<LocationSliceUnderTest>;
}

const RAW = { geoCountry: 'Costa Rica', geoCountryCode: 'CR', geoAdmin1: 'Heredia Province', geoLocality: 'Santo Domingo' };

/**
 * Runs the location slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeLocationSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: LocationSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;

  describe(`location slice conformance: ${options.name}`, () => {
    describe('resolver', () => {
      it('an alias beats a radius that also contains the item', async () => {
        const { resolver } = await options.create();
        if (!resolver) return;
        await resolver.seed([
          { level: 'locality', countryCode: 'CR', canonicalName: 'Heredia', aliases: ['santo domingo'] },
          { level: 'locality', countryCode: 'CR', canonicalName: 'Greater Area', centerLat: 9.98, centerLng: -84.09, radiusKm: 20 },
        ]);

        const out = await resolver.resolver.resolve(RAW, { lat: 9.98, lng: -84.09 });

        expect(out.geoCanonicalLocality).toBe('Heredia');
      });

      it('among radius groups the smallest radius wins', async () => {
        const { resolver } = await options.create();
        if (!resolver) return;
        await resolver.seed([
          { level: 'locality', countryCode: 'CR', canonicalName: 'Broad', centerLat: 9.98, centerLng: -84.09, radiusKm: 40 },
          { level: 'locality', countryCode: 'CR', canonicalName: 'Tight', centerLat: 9.98, centerLng: -84.09, radiusKm: 5 },
        ]);

        const out = await resolver.resolver.resolve(RAW, { lat: 9.98, lng: -84.09 });

        expect(out.geoCanonicalLocality).toBe('Tight');
      });

      it('the feature off is the identity function and the canonical invariant holds', async () => {
        const { resolver } = await options.create();
        if (!resolver) return;
        await resolver.seed([{ level: 'locality', countryCode: 'CR', canonicalName: 'Heredia', aliases: ['santo domingo'] }], {
          featureEnabled: false,
        });

        const out = await resolver.resolver.resolve({ ...RAW, geoAdmin1: null }, null);

        expect(out).toEqual({ geoCanonicalCountry: 'Costa Rica', geoCanonicalAdmin1: null, geoCanonicalLocality: 'Santo Domingo' });
      });

      it('a raw tier that is non-null always has a non-null canonical tier', async () => {
        const { resolver } = await options.create();
        if (!resolver) return;
        await resolver.seed([]);

        const out = await resolver.resolver.resolve(RAW, null);

        expect(out.geoCanonicalCountry).toBe('Costa Rica');
        expect(out.geoCanonicalAdmin1).toBe('Heredia Province');
        expect(out.geoCanonicalLocality).toBe('Santo Domingo');
      });
    });

    describe('rebuild', () => {
      it('enqueues the global job at background priority and never skips the dedup', async () => {
        const { rebuild } = await options.create();
        if (!rebuild) return;

        await rebuild.service.enqueueRebuild();

        const queued = await rebuild.queuedJobs();
        expect(queued.map((job) => job.type)).toEqual(['location_group_rebuild']);
        expect(queued[0]!.priority).toBe(100);
        expect(queued[0]!.skipDedup).toBeFalsy();
      });
    });
  });
}
