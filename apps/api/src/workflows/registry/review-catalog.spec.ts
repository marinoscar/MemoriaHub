/**
 * Unit tests for the review-queue half of the Media Item workflow catalog (RETRO-J9, #622).
 *
 * The workflows slice holds the built-in item-level catalog and knows no review queue; this app registers the
 * burst, duplicate and location-suggestion fields and actions on top (`registerReviewCatalog`). These tests moved
 * from the compiler and subject-registry specs, which now cover the built-in catalog in the package, and run
 * against the full catalog the app serves.
 */
import {
  WorkflowConditionCompiler,
  getSubjectRegistry,
  isRegisteredAction,
} from '@marinoscar/memoriahub-api/workflows';
import type { WorkflowDefinition } from '@marinoscar/memoriahub-api/workflows';
import { registerReviewCatalog, REVIEW_ACTIONS, REVIEW_FIELDS } from './review-catalog';

const CIRCLE_ID = 'circle-abc-123';

const fields = () => getSubjectRegistry('media_item')!.fields;

function baseDef(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: 1,
    subject: 'media_item',
    match: 'all',
    conditions: [],
    actions: [],
    ...overrides,
  } as WorkflowDefinition;
}

beforeAll(() => {
  registerReviewCatalog();
});

describe('review catalog registration', () => {
  it('registers every review field and action once, after the built-ins, and is idempotent', () => {
    registerReviewCatalog();
    registerReviewCatalog();
    const entry = getSubjectRegistry('media_item')!;
    for (const f of REVIEW_FIELDS) expect(entry.fields.filter((x) => x.key === f.key)).toHaveLength(1);
    for (const a of REVIEW_ACTIONS) expect(entry.actions.filter((x) => x.type === a.type)).toHaveLength(1);
    for (const a of REVIEW_ACTIONS) expect(isRegisteredAction('media_item', a.type)).toBe(true);
    const keys = entry.fields.map((f) => f.key);
    expect(keys.indexOf('inPendingBurstGroup')).toBeGreaterThan(keys.indexOf('filename'));
  });
});

describe('review catalog (compiler)', () => {
  let compiler: WorkflowConditionCompiler;

  beforeEach(() => {
    compiler = new WorkflowConditionCompiler();
  });

  describe('review-state descriptors', () => {
    it('inPendingBurstGroup:true compiles to burstGroup.is.status=pending', () => {
      const def = baseDef({
        conditions: [{ field: 'inPendingBurstGroup', op: 'is', value: true }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ burstGroup: { is: { status: 'pending' } } });
    });

    it('inPendingBurstGroup:false compiles to burstGroup.isNot.status=pending', () => {
      const def = baseDef({
        conditions: [{ field: 'inPendingBurstGroup', op: 'is', value: false }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ burstGroup: { isNot: { status: 'pending' } } });
    });

    it('burstGroupConfidence gte compiles to a pure indexed relation predicate', () => {
      const def = baseDef({
        conditions: [{ field: 'burstGroupConfidence', op: 'gte', value: 0.8 }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({
        burstGroup: { is: { status: 'pending', confidence: { gte: 0.8 } } },
      });
    });

    it('inPendingDuplicateGroup:true compiles to duplicateGroup.is.status=pending', () => {
      const def = baseDef({
        conditions: [{ field: 'inPendingDuplicateGroup', op: 'is', value: true }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ duplicateGroup: { is: { status: 'pending' } } });
    });

    it('duplicateGroupConfidence compiles to the bounding predicate ONLY (no threshold in where)', () => {
      // Documented Phase-1 limitation: duplicate confidence is computed at read
      // time (not persisted), so the where clause cannot express the threshold —
      // it only narrows to "already in a pending duplicate group".
      const def = baseDef({
        conditions: [{ field: 'duplicateGroupConfidence', op: 'gte', value: 0.9 }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ duplicateGroup: { is: { status: 'pending' } } });
    });

    it('hasPendingLocationSuggestion:true compiles to locationSuggestion.is.status=pending', () => {
      const def = baseDef({
        conditions: [{ field: 'hasPendingLocationSuggestion', op: 'is', value: true }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ locationSuggestion: { is: { status: 'pending' } } });
    });

    it('locationSuggestionConfidence gte compiles to a pure indexed relation predicate', () => {
      const def = baseDef({
        conditions: [{ field: 'locationSuggestionConfidence', op: 'gte', value: 0.75 }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({
        locationSuggestion: { is: { status: 'pending', confidence: { gte: 0.75 } } },
      });
    });

    it('locationSuggestionMethod equals compiles to locationSuggestion.is.method', () => {
      const def = baseDef({
        conditions: [{ field: 'locationSuggestionMethod', op: 'equals', value: 'interpolated' }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({
        locationSuggestion: { is: { status: 'pending', method: 'interpolated' } },
      });
    });
  });

    it('duplicateGroupConfidence is readTimeRefinement but has no refinementPredicate — never collected', () => {
      const def = baseDef({
        match: 'all',
        conditions: [{ field: 'duplicateGroupConfidence', op: 'gte', value: 0.9 }],
      });
      const { refinements } = compiler.compile(CIRCLE_ID, def);
      expect(refinements).toHaveLength(0);
    });

    it('mixing metadata + tags + faces + bursts + duplicates + locationSuggestions yields all six, deduped', () => {
      const def = baseDef({
        match: 'all',
        conditions: [
          { field: 'filename', op: 'contains', value: 'x' },
          { field: 'uploadedAt', op: 'before', value: '2024-01-01T00:00:00.000Z' }, // metadata again (dedup)
          { field: 'tags', op: 'has_any', value: ['a'] },
          { field: 'noFaces', op: 'is', value: true }, // faces
          { field: 'inPendingBurstGroup', op: 'is', value: true }, // bursts
          { field: 'inPendingDuplicateGroup', op: 'is', value: true }, // duplicates
          { field: 'hasPendingLocationSuggestion', op: 'is', value: true }, // locationSuggestions
        ],
      });
      const deps = compiler.deriveDependencies(def);
      expect(new Set(deps)).toEqual(
        new Set(['metadata', 'tags', 'faces', 'bursts', 'duplicates', 'locationSuggestions']),
      );
      expect(deps).toHaveLength(6); // deduped, no repeats
    });

    it('also unions dependencies while compiling a full where (compile() populates the same set)', () => {
      const def = baseDef({
        conditions: [
          { field: 'tags', op: 'has_any', value: ['a'] },
          { field: 'inPendingBurstGroup', op: 'is', value: true },
        ],
      });
      const { dependencies } = compiler.compile(CIRCLE_ID, def);
      expect(dependencies).toEqual(new Set(['tags', 'bursts']));
    });
});

describe('review catalog (registry)', () => {
    it('includes the documented review-state descriptors', () => {
      const keys = fields().map((f) => f.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'inPendingBurstGroup',
          'burstGroupConfidence',
          'inPendingDuplicateGroup',
          'duplicateGroupConfidence',
          'hasPendingLocationSuggestion',
          'locationSuggestionConfidence',
          'locationSuggestionMethod',
        ]),
      );
    });

    it('every readTimeRefinement field is documented as such and buildWhere still returns a bounding predicate', () => {
      const refinementFields = fields().filter((f) => f.readTimeRefinement);
      expect(refinementFields.map((f) => f.key).sort()).toEqual(
        ['duplicateGroupConfidence', 'megapixels', 'orientationShape'].sort(),
      );
      for (const field of refinementFields) {
        expect(field.buildWhere('gt' as any, 1)).toBeDefined();
      }
    });
});
