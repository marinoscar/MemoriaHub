/**
 * Unit tests for archive filtering in media-where.builder and
 * searchable-fields.registry.
 *
 * These are pure function tests — no NestJS module or DB required.
 */
import {
  buildMediaWhere,
  whereExcludeArchived,
} from './media-where.builder';
import { buildWhereFromFields, SEARCHABLE_FIELDS } from './searchable-fields.registry';

const CIRCLE_ID = 'circle-archive-test-001';

// ---------------------------------------------------------------------------
// whereExcludeArchived helper
// ---------------------------------------------------------------------------

describe('whereExcludeArchived', () => {
  it('returns { archivedAt: null } when value is true', () => {
    expect(whereExcludeArchived(true)).toEqual({ archivedAt: null });
  });

  it('returns {} when value is false', () => {
    expect(whereExcludeArchived(false)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildMediaWhere — excludeArchived filter
// ---------------------------------------------------------------------------

describe('buildMediaWhere — excludeArchived filter', () => {
  it('always includes deletedAt: null regardless of excludeArchived', () => {
    const where = buildMediaWhere(CIRCLE_ID, { excludeArchived: true });
    expect(where).toMatchObject({ deletedAt: null });
  });

  it('adds archivedAt: null when excludeArchived is true', () => {
    const where = buildMediaWhere(CIRCLE_ID, { excludeArchived: true }) as any;
    expect(where.archivedAt).toBeNull();
  });

  it('does NOT add archivedAt when excludeArchived is false', () => {
    const where = buildMediaWhere(CIRCLE_ID, { excludeArchived: false }) as any;
    expect(where.archivedAt).toBeUndefined();
  });

  it('does NOT add archivedAt when excludeArchived is omitted (undefined)', () => {
    const where = buildMediaWhere(CIRCLE_ID, {}) as any;
    expect(where.archivedAt).toBeUndefined();
  });

  it('baseline where always contains circleId and deletedAt', () => {
    const where = buildMediaWhere(CIRCLE_ID, {});
    expect(where).toMatchObject({ circleId: CIRCLE_ID, deletedAt: null });
  });
});

// ---------------------------------------------------------------------------
// buildWhereFromFields — excludeArchived via registry
// ---------------------------------------------------------------------------

describe('buildWhereFromFields — excludeArchived filter', () => {
  it('does NOT include archivedAt in the baseline when no filters are set', () => {
    const where = buildWhereFromFields(CIRCLE_ID, {}) as any;
    expect(where.archivedAt).toBeUndefined();
    // Baseline is just circleId + deletedAt
    expect(where).toMatchObject({ circleId: CIRCLE_ID, deletedAt: null });
  });

  it('adds archivedAt: null when excludeArchived: true is passed', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { excludeArchived: true }) as any;
    expect(where.archivedAt).toBeNull();
  });

  it('does NOT add archivedAt when excludeArchived: false is passed', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { excludeArchived: false }) as any;
    expect(where.archivedAt).toBeUndefined();
  });

  it('still includes deletedAt: null when excludeArchived: true is passed', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { excludeArchived: true });
    expect(where).toMatchObject({ deletedAt: null });
  });

  it('archived items are included in search by default (no archivedAt filter in baseline)', () => {
    // The spec says archived is included in search by default.
    // Confirm that calling buildWhereFromFields with empty filters
    // does NOT produce archivedAt: null.
    const where = buildWhereFromFields(CIRCLE_ID, {}) as any;
    expect(where.archivedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SEARCHABLE_FIELDS — excludeArchived field descriptor
// ---------------------------------------------------------------------------

describe('SEARCHABLE_FIELDS — excludeArchived field', () => {
  function getField() {
    return SEARCHABLE_FIELDS.find((f) => f.key === 'excludeArchived');
  }

  it('contains the excludeArchived key', () => {
    const keys = SEARCHABLE_FIELDS.map((f) => f.key);
    expect(keys).toContain('excludeArchived');
  });

  it('excludeArchived field has type "boolean"', () => {
    const field = getField()!;
    expect(field).toBeDefined();
    expect(field.type).toBe('boolean');
  });

  it('excludeArchived field has a label', () => {
    const field = getField()!;
    expect(typeof field.label).toBe('string');
    expect(field.label.length).toBeGreaterThan(0);
  });

  it('excludeArchived field has a description', () => {
    const field = getField()!;
    expect(typeof field.description).toBe('string');
    expect(field.description.length).toBeGreaterThan(0);
  });

  it('excludeArchived field has a buildWhere function', () => {
    const field = getField()!;
    expect(typeof field.buildWhere).toBe('function');
  });

  it('buildWhere returns { archivedAt: null } when true', () => {
    const field = getField()!;
    expect(field.buildWhere(true)).toEqual({ archivedAt: null });
  });

  it('buildWhere returns {} when false', () => {
    const field = getField()!;
    expect(field.buildWhere(false)).toEqual({});
  });

  it('buildWhere returns {} when undefined', () => {
    const field = getField()!;
    expect(field.buildWhere(undefined)).toEqual({});
  });
});
