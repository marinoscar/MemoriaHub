/**
 * Mock LocationGroupResolverService (issue #373).
 *
 * Defaults to the IDENTITY resolver — exactly what the real service does when
 * `features.locationGrouping` is off, which is the default for every existing
 * spec. Canonical columns therefore come out equal to their raw counterparts,
 * preserving the "raw non-null ⇒ canonical non-null" invariant without any
 * spec having to know the feature exists.
 *
 * Override `resolve` in a spec that actually exercises grouping.
 */
export interface MockLocationGroupResolver {
  resolve: jest.Mock;
  getSnapshot: jest.Mock;
  invalidate: jest.Mock;
  resolveTier: jest.Mock;
}

export function createMockLocationGroupResolver(): MockLocationGroupResolver {
  return {
    resolve: jest.fn().mockImplementation(
      (raw: {
        geoCountry: string | null;
        geoAdmin1: string | null;
        geoLocality: string | null;
      }) =>
        Promise.resolve({
          geoCanonicalCountry: raw?.geoCountry ?? null,
          geoCanonicalAdmin1: raw?.geoAdmin1 ?? null,
          geoCanonicalLocality: raw?.geoLocality ?? null,
        }),
    ),
    getSnapshot: jest.fn().mockResolvedValue({ aliases: new Map(), areas: [] }),
    invalidate: jest.fn(),
    resolveTier: jest.fn().mockImplementation((_s, _l, _c, rawValue: string | null) => rawValue),
  };
}
