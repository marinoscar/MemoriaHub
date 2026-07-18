/**
 * Unit tests for WorkflowConditionCompiler (issue #139).
 *
 * Pure function tests — no NestJS module or DB needed. The compiler resolves
 * field descriptors from the media_item registry and composes Prisma `where`
 * fragments following the shared-array AND/OR composition rule documented in
 * docs/audits/search-audit.md.
 */
import { WorkflowConditionCompiler } from './workflow-condition.compiler';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';

const CIRCLE_ID = 'circle-abc-123';

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

describe('WorkflowConditionCompiler', () => {
  let compiler: WorkflowConditionCompiler;

  beforeEach(() => {
    compiler = new WorkflowConditionCompiler();
  });

  // ---------------------------------------------------------------------------
  // Baseline + empty conditions
  // ---------------------------------------------------------------------------

  describe('baseline scoping', () => {
    it('always includes circleId and deletedAt:null', () => {
      const { where } = compiler.compile(CIRCLE_ID, baseDef());
      expect(where).toEqual({ circleId: CIRCLE_ID, deletedAt: null });
    });

    it('adds no AND/OR key when conditions is empty (matches every non-deleted item)', () => {
      const { where } = compiler.compile(CIRCLE_ID, baseDef({ conditions: [] }));
      expect((where as any).AND).toBeUndefined();
      expect((where as any).OR).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Per-field-type compilation
  // ---------------------------------------------------------------------------

  describe('filename', () => {
    it('contains compiles to originalFilename.contains (case-insensitive)', () => {
      const def = baseDef({
        conditions: [{ field: 'filename', op: 'contains', value: 'screenshot' }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND).toEqual([
        { originalFilename: { contains: 'screenshot', mode: 'insensitive' } },
      ]);
    });

    it('starts_with compiles to originalFilename.startsWith', () => {
      const def = baseDef({
        conditions: [{ field: 'filename', op: 'starts_with', value: 'IMG_' }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({
        originalFilename: { startsWith: 'IMG_', mode: 'insensitive' },
      });
    });
  });

  describe('mimeType', () => {
    it('equals compiles to storageObject.mimeType relation filter', () => {
      const def = baseDef({
        conditions: [{ field: 'mimeType', op: 'equals', value: 'image/png' }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ storageObject: { mimeType: 'image/png' } });
    });
  });

  describe('capturedAt', () => {
    it('between compiles to capturedAt gte/lte via whereDateRange', () => {
      const from = '2024-01-01T00:00:00.000Z';
      const to = '2024-12-31T00:00:00.000Z';
      const def = baseDef({
        conditions: [{ field: 'capturedAt', op: 'between', value: { from, to } }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({
        capturedAt: { gte: new Date(from), lte: new Date(to) },
      });
    });

    it('older_than_days compiles to capturedAt.lt a cutoff Date', () => {
      const def = baseDef({
        conditions: [{ field: 'capturedAt', op: 'older_than_days', value: 30 }],
      });
      const before = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const { where } = compiler.compile(CIRCLE_ID, def);
      const clause = (where as any).AND[0].capturedAt.lt as Date;
      // Cutoff computed at compile time — allow a small tolerance for test execution jitter.
      expect(Math.abs(clause.getTime() - before)).toBeLessThan(5000);
    });

    it('within_last_days compiles to capturedAt.gte a cutoff Date', () => {
      const def = baseDef({
        conditions: [{ field: 'capturedAt', op: 'within_last_days', value: 7 }],
      });
      const after = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const { where } = compiler.compile(CIRCLE_ID, def);
      const clause = (where as any).AND[0].capturedAt.gte as Date;
      expect(Math.abs(clause.getTime() - after)).toBeLessThan(5000);
    });
  });

  describe('missingCamera', () => {
    it('is:true compiles to {cameraMake:null, cameraModel:null}', () => {
      const def = baseDef({
        conditions: [{ field: 'missingCamera', op: 'is', value: true }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ cameraMake: null, cameraModel: null });
    });
  });

  describe('tags', () => {
    const tagMatch = (name: string) => ({ mediaTags: { some: { tag: { name: { equals: name, mode: 'insensitive' } } } } });

    it('has_any compiles to an OR of tag-name matches', () => {
      const def = baseDef({
        conditions: [{ field: 'tags', op: 'has_any', value: ['beach', 'sunset'] }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ OR: [tagMatch('beach'), tagMatch('sunset')] });
    });

    it('has_all compiles to an AND of tag-name matches', () => {
      const def = baseDef({
        conditions: [{ field: 'tags', op: 'has_all', value: ['beach', 'sunset'] }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ AND: [tagMatch('beach'), tagMatch('sunset')] });
    });

    it('has_none compiles to an AND of NOT tag-name matches', () => {
      const def = baseDef({
        conditions: [{ field: 'tags', op: 'has_none', value: ['spam'] }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ AND: [{ NOT: tagMatch('spam') }] });
    });
  });

  describe('people', () => {
    const ID_A = '11111111-1111-1111-1111-111111111111';
    const ID_B = '22222222-2222-2222-2222-222222222222';

    it('has_person with mode:any compiles via wherePeople(any)', () => {
      const def = baseDef({
        conditions: [{ field: 'people', op: 'has_person', value: { ids: [ID_A, ID_B], mode: 'any' } }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ faces: { some: { personId: { in: [ID_A, ID_B] } } } });
    });

    it('has_person defaults to mode:any when mode is omitted', () => {
      // media-item-fields.ts: `const mode = v.mode === 'all' ? 'all' : 'any'` —
      // any value other than the literal 'all' (including omitted) resolves to 'any'.
      const def = baseDef({
        conditions: [{ field: 'people', op: 'has_person', value: { ids: [ID_A] } }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({ faces: { some: { personId: { in: [ID_A] } } } });
    });

    it('has_person with mode:all compiles via wherePeople(all)', () => {
      const def = baseDef({
        conditions: [{ field: 'people', op: 'has_person', value: { ids: [ID_A, ID_B], mode: 'all' } }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({
        AND: [
          { faces: { some: { personId: ID_A } } },
          { faces: { some: { personId: ID_B } } },
        ],
      });
    });

    it('not_has_person compiles to a NOT wrapper around faces.some.personId.in', () => {
      const def = baseDef({
        conditions: [{ field: 'people', op: 'not_has_person', value: { ids: [ID_A] } }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND[0]).toEqual({
        NOT: { faces: { some: { personId: { in: [ID_A] } } } },
      });
    });
  });

  describe('near', () => {
    it('compiles to a takenLat/takenLng bounding box', () => {
      const def = baseDef({
        conditions: [{ field: 'near', op: 'near', value: { lat: 9.93, lng: -84.09, radiusKm: 50 } }],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      const clause = (where as any).AND[0];
      expect(clause).toHaveProperty('takenLat.gte');
      expect(clause).toHaveProperty('takenLat.lte');
      expect(clause).toHaveProperty('takenLng.gte');
      expect(clause).toHaveProperty('takenLng.lte');
    });
  });

  // ---------------------------------------------------------------------------
  // Review-state descriptors
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // match: all/any composition + one nested group level
  // ---------------------------------------------------------------------------

  describe('match composition', () => {
    it('match:all composes fragments into an AND array', () => {
      const def = baseDef({
        match: 'all',
        conditions: [
          { field: 'missingCamera', op: 'is', value: true },
          { field: 'missingCapturedAt', op: 'is', value: true },
        ],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).AND).toHaveLength(2);
      expect((where as any).OR).toBeUndefined();
    });

    it('match:any composes fragments into an OR array', () => {
      const def = baseDef({
        match: 'any',
        conditions: [
          { field: 'favorite', op: 'is', value: true },
          { field: 'archived', op: 'is', value: true },
        ],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      expect((where as any).OR).toEqual([{ favorite: true }, { archivedAt: { not: null } }]);
      expect((where as any).AND).toBeUndefined();
    });

    it('a single nested group compiles into a nested array under the root array', () => {
      // The screenshot heuristic: filename contains "screenshot" OR
      // (mimeType=png AND missingCamera AND missingCapturedAt).
      const def = baseDef({
        match: 'any',
        conditions: [
          { field: 'filename', op: 'contains', value: 'screenshot' },
          {
            match: 'all',
            conditions: [
              { field: 'mimeType', op: 'equals', value: 'image/png' },
              { field: 'missingCamera', op: 'is', value: true },
              { field: 'missingCapturedAt', op: 'is', value: true },
            ],
          },
        ],
      });
      const { where } = compiler.compile(CIRCLE_ID, def);
      const or = (where as any).OR as any[];
      expect(or).toHaveLength(2);
      expect(or[0]).toEqual({ originalFilename: { contains: 'screenshot', mode: 'insensitive' } });
      expect(or[1]).toEqual({
        AND: [
          { storageObject: { mimeType: 'image/png' } },
          { cameraMake: null, cameraModel: null },
          { capturedAt: null },
        ],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Read-time refinements: orientationShape / megapixels
  // ---------------------------------------------------------------------------

  describe('read-time refinements', () => {
    it('orientationShape on a pure-AND root path is collected as a refinement', () => {
      const def = baseDef({
        match: 'all',
        conditions: [{ field: 'orientationShape', op: 'equals', value: 'portrait' }],
      });
      const { where, refinements } = compiler.compile(CIRCLE_ID, def);
      // Bounding predicate only narrows to "both dimensions present".
      expect((where as any).AND[0]).toEqual({ width: { not: null }, height: { not: null } });
      expect(refinements).toHaveLength(1);
      expect(refinements[0].field).toBe('orientationShape');
      expect(refinements[0].select).toEqual({ width: true, height: true });
      expect(refinements[0].predicate({ width: 100, height: 200 })).toBe(true); // portrait
      expect(refinements[0].predicate({ width: 200, height: 100 })).toBe(false); // landscape
      expect(refinements[0].predicate({ width: null, height: 200 })).toBe(false); // missing dims
    });

    it('megapixels on a pure-AND root path is collected as a refinement', () => {
      const def = baseDef({
        match: 'all',
        conditions: [{ field: 'megapixels', op: 'gt', value: 12 }],
      });
      const { refinements } = compiler.compile(CIRCLE_ID, def);
      expect(refinements).toHaveLength(1);
      expect(refinements[0].field).toBe('megapixels');
      // 4000x3000 = 12MP exactly -> not > 12
      expect(refinements[0].predicate({ width: 4000, height: 3000 })).toBe(false);
      // 5000x4000 = 20MP -> > 12
      expect(refinements[0].predicate({ width: 5000, height: 4000 })).toBe(true);
    });

    it('is NOT collected when the root match is "any" (OR-nested path)', () => {
      const def = baseDef({
        match: 'any',
        conditions: [
          { field: 'orientationShape', op: 'equals', value: 'portrait' },
          { field: 'favorite', op: 'is', value: true },
        ],
      });
      const { refinements } = compiler.compile(CIRCLE_ID, def);
      expect(refinements).toHaveLength(0);
    });

    it('is NOT collected when nested inside a match:"any" group even under a match:"all" root', () => {
      const def = baseDef({
        match: 'all',
        conditions: [
          {
            match: 'any',
            conditions: [{ field: 'orientationShape', op: 'equals', value: 'square' }],
          },
        ],
      });
      const { refinements } = compiler.compile(CIRCLE_ID, def);
      expect(refinements).toHaveLength(0);
    });

    it('IS collected when nested inside a match:"all" group under a match:"all" root', () => {
      const def = baseDef({
        match: 'all',
        conditions: [
          {
            match: 'all',
            conditions: [{ field: 'orientationShape', op: 'equals', value: 'square' }],
          },
        ],
      });
      const { refinements } = compiler.compile(CIRCLE_ID, def);
      expect(refinements).toHaveLength(1);
      expect(refinements[0].field).toBe('orientationShape');
    });

    it('duplicateGroupConfidence is readTimeRefinement but has no refinementPredicate — never collected', () => {
      const def = baseDef({
        match: 'all',
        conditions: [{ field: 'duplicateGroupConfidence', op: 'gte', value: 0.9 }],
      });
      const { refinements } = compiler.compile(CIRCLE_ID, def);
      expect(refinements).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Dependency-set derivation
  // ---------------------------------------------------------------------------

  describe('dependency-set derivation', () => {
    it('a metadata-only field yields {metadata}', () => {
      const def = baseDef({
        conditions: [{ field: 'filename', op: 'contains', value: 'x' }],
      });
      expect(compiler.deriveDependencies(def)).toEqual(['metadata']);
    });

    it('a tags condition yields {tags}', () => {
      const def = baseDef({
        conditions: [{ field: 'tags', op: 'has_any', value: ['a'] }],
      });
      expect(compiler.deriveDependencies(def)).toEqual(['tags']);
    });

    it('a people condition yields {faces}', () => {
      const def = baseDef({
        conditions: [
          { field: 'people', op: 'has_person', value: { ids: ['11111111-1111-1111-1111-111111111111'] } },
        ],
      });
      expect(compiler.deriveDependencies(def)).toEqual(['faces']);
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

    it('derives dependencies from leaves nested inside a group', () => {
      const def = baseDef({
        match: 'any',
        conditions: [
          { field: 'favorite', op: 'is', value: true },
          {
            match: 'all',
            conditions: [{ field: 'tags', op: 'has_any', value: ['a'] }],
          },
        ],
      });
      expect(new Set(compiler.deriveDependencies(def))).toEqual(new Set(['metadata', 'tags']));
    });

    it('returns an empty array for an empty conditions list', () => {
      const def = baseDef({ conditions: [] });
      expect(compiler.deriveDependencies(def)).toEqual([]);
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
});
