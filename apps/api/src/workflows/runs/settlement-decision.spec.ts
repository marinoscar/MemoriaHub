/**
 * Unit tests for `isFullySettled` (Media Workflow Automation Phase 4, issue
 * #142) -- the pure predicate WorkflowTriggerListener uses to decide whether
 * an item is evaluable for an on_media_enriched workflow. Pure function, no
 * I/O.
 */
import { DependencyState, isFullySettled } from './settlement-decision';

function state(overrides: Partial<DependencyState> = {}): DependencyState {
  return {
    metadata: true,
    tags: true,
    faces: true,
    bursts: true,
    duplicates: true,
    locationSuggestions: true,
    ...overrides,
  };
}

describe('isFullySettled', () => {
  it('is true for an empty dependency set regardless of state', () => {
    expect(isFullySettled(new Set(), state({ tags: false, faces: false }))).toBe(true);
  });

  it('is true when the single required dependency is settled', () => {
    expect(isFullySettled(new Set(['tags']), state({ tags: true }))).toBe(true);
  });

  it('is false when the single required dependency is not settled', () => {
    expect(isFullySettled(new Set(['tags']), state({ tags: false }))).toBe(false);
  });

  it('is true only once EVERY dependency in a multi-dependency set is settled', () => {
    const deps = new Set<'tags' | 'faces' | 'bursts'>(['tags', 'faces', 'bursts']);
    expect(isFullySettled(deps, state({ tags: true, faces: true, bursts: false }))).toBe(false);
    expect(isFullySettled(deps, state({ tags: true, faces: true, bursts: true }))).toBe(true);
  });

  it('ignores dependencies not present in the requested set', () => {
    // faces is false in the snapshot but not requested -- must not affect the result.
    expect(isFullySettled(new Set(['tags']), state({ tags: true, faces: false }))).toBe(true);
  });

  it('is false when metadata is requested but not yet settled', () => {
    expect(isFullySettled(new Set(['metadata']), state({ metadata: false }))).toBe(false);
  });

  it.each(['tags', 'faces', 'bursts', 'duplicates', 'locationSuggestions'] as const)(
    'evaluates the "%s" dependency independently of the others',
    (dep) => {
      const deps = new Set([dep]);
      expect(isFullySettled(deps, state({ [dep]: true } as Partial<DependencyState>))).toBe(true);
      expect(isFullySettled(deps, state({ [dep]: false } as Partial<DependencyState>))).toBe(
        false,
      );
    },
  );
});
