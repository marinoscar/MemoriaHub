/**
 * Unit tests for media-where.builder and searchable-fields.registry.
 *
 * These are pure function tests — no NestJS module or DB needed.
 */
import { BadRequestException } from '@nestjs/common';
import {
  buildMediaWhere,
  MediaFilters,
  whereTag,
  whereCountry,
  whereLocality,
  whereFavorite,
  whereType,
} from './media-where.builder';
import { buildWhereFromFields, SEARCHABLE_FIELDS } from './searchable-fields.registry';

const CIRCLE_ID = 'circle-abc-123';

// ---------------------------------------------------------------------------
// buildMediaWhere
// ---------------------------------------------------------------------------
describe('buildMediaWhere', () => {
  it('always includes circleId and deletedAt:null', () => {
    const where = buildMediaWhere(CIRCLE_ID, {});
    expect(where).toMatchObject({ circleId: CIRCLE_ID, deletedAt: null });
  });

  it('returns only baseline when filters are empty', () => {
    const where = buildMediaWhere(CIRCLE_ID, {});
    expect(Object.keys(where)).toEqual(
      expect.arrayContaining(['circleId', 'deletedAt']),
    );
    // Should NOT have stray keys from un-applied filters
    expect((where as any).type).toBeUndefined();
    expect((where as any).favorite).toBeUndefined();
  });

  describe('tag filter', () => {
    it('produces mediaTags.some.tag.name.equals for tag filter', () => {
      const where = buildMediaWhere(CIRCLE_ID, { tag: 'vacation' });
      expect(where).toMatchObject({
        circleId: CIRCLE_ID,
        deletedAt: null,
        mediaTags: {
          some: {
            tag: {
              name: {
                equals: 'vacation',
              },
            },
          },
        },
      });
    });
  });

  describe('country filter', () => {
    it('produces OR clause covering geoCountry and geoCountryCode', () => {
      const where = buildMediaWhere(CIRCLE_ID, { country: 'CR' });
      expect(where).toMatchObject({ circleId: CIRCLE_ID });
      const or = (where as any).OR as unknown[];
      expect(Array.isArray(or)).toBe(true);
      expect(or).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ geoCountry: expect.any(Object) }),
          expect.objectContaining({ geoCountryCode: expect.any(Object) }),
        ]),
      );
    });
  });

  describe('locality filter', () => {
    it('produces geoLocality contains clause', () => {
      const where = buildMediaWhere(CIRCLE_ID, { locality: 'San José' });
      expect(where).toMatchObject({
        geoLocality: { contains: 'San José', mode: 'insensitive' },
      });
    });
  });

  describe('date range filter', () => {
    it('produces capturedAt.gte and lte when both bounds are provided', () => {
      const from = new Date('2023-01-01');
      const to = new Date('2023-12-31');
      const where = buildMediaWhere(CIRCLE_ID, {
        capturedAtFrom: from,
        capturedAtTo: to,
      });
      expect(where).toMatchObject({
        capturedAt: { gte: from, lte: to },
      });
    });

    it('produces only gte when only from is provided', () => {
      const from = new Date('2023-06-01');
      const where = buildMediaWhere(CIRCLE_ID, { capturedAtFrom: from });
      expect((where as any).capturedAt).toMatchObject({ gte: from });
      expect((where as any).capturedAt.lte).toBeUndefined();
    });

    it('produces only lte when only to is provided', () => {
      const to = new Date('2023-06-01');
      const where = buildMediaWhere(CIRCLE_ID, { capturedAtTo: to });
      expect((where as any).capturedAt).toMatchObject({ lte: to });
      expect((where as any).capturedAt.gte).toBeUndefined();
    });
  });

  describe('type filter', () => {
    it('sets type to the provided value', () => {
      const where = buildMediaWhere(CIRCLE_ID, { type: 'photo' });
      expect((where as any).type).toBe('photo');
    });

    it('sets type to video', () => {
      const where = buildMediaWhere(CIRCLE_ID, { type: 'video' });
      expect((where as any).type).toBe('video');
    });
  });

  describe('favorite filter', () => {
    it('sets favorite:true when true', () => {
      const where = buildMediaWhere(CIRCLE_ID, { favorite: true });
      expect((where as any).favorite).toBe(true);
    });

    it('sets favorite:false when false', () => {
      const where = buildMediaWhere(CIRCLE_ID, { favorite: false });
      expect((where as any).favorite).toBe(false);
    });
  });

  describe('combined filters', () => {
    it('applies multiple filters simultaneously', () => {
      const from = new Date('2022-01-01');
      const filters: MediaFilters = {
        type: 'photo',
        tag: 'beach',
        country: 'CR',
        capturedAtFrom: from,
        favorite: true,
      };
      const where = buildMediaWhere(CIRCLE_ID, filters);
      expect(where).toMatchObject({ circleId: CIRCLE_ID, deletedAt: null });
      expect((where as any).type).toBe('photo');
      expect((where as any).favorite).toBe(true);
      expect((where as any).mediaTags).toBeDefined();
      expect(Array.isArray((where as any).OR)).toBe(true);
      expect((where as any).capturedAt?.gte).toEqual(from);
    });
  });

  describe('noFaces filter', () => {
    it('produces faces.none clause when noFaces is true', () => {
      const where = buildMediaWhere(CIRCLE_ID, { noFaces: true });
      expect((where as any).faces).toEqual({ none: {} });
    });

    it('adds nothing extra when noFaces is false', () => {
      const where = buildMediaWhere(CIRCLE_ID, { noFaces: false });
      expect((where as any).faces).toBeUndefined();
    });

    it('adds nothing extra when noFaces is undefined', () => {
      const where = buildMediaWhere(CIRCLE_ID, {});
      expect((where as any).faces).toBeUndefined();
    });
  });

  describe('missingCapturedAt filter', () => {
    it('produces capturedAt:null when missingCapturedAt is true', () => {
      const where = buildMediaWhere(CIRCLE_ID, { missingCapturedAt: true });
      expect((where as any).capturedAt).toBeNull();
    });

    it('produces capturedAt:{not:null} when missingCapturedAt is false', () => {
      const where = buildMediaWhere(CIRCLE_ID, { missingCapturedAt: false });
      expect((where as any).capturedAt).toEqual({ not: null });
    });

    it('adds no capturedAt key when missingCapturedAt is omitted', () => {
      const where = buildMediaWhere(CIRCLE_ID, {});
      // capturedAt must be absent when neither date-range nor missingCapturedAt is supplied
      expect((where as any).capturedAt).toBeUndefined();
    });
  });

  describe('missingCamera filter', () => {
    it('produces {cameraMake:null, cameraModel:null} when missingCamera is true', () => {
      const where = buildMediaWhere(CIRCLE_ID, { missingCamera: true });
      expect((where as any).cameraMake).toBeNull();
      expect((where as any).cameraModel).toBeNull();
    });

    it('produces OR clause [{cameraMake:{not:null}}, {cameraModel:{not:null}}] when missingCamera is false', () => {
      const where = buildMediaWhere(CIRCLE_ID, { missingCamera: false });
      const or = (where as any).OR as unknown[];
      expect(Array.isArray(or)).toBe(true);
      expect(or).toEqual([{ cameraMake: { not: null } }, { cameraModel: { not: null } }]);
    });

    it('adds no cameraMake or cameraModel key when missingCamera is omitted', () => {
      const where = buildMediaWhere(CIRCLE_ID, {});
      expect((where as any).cameraMake).toBeUndefined();
      expect((where as any).cameraModel).toBeUndefined();
    });
  });

  describe('helper functions directly', () => {
    it('whereTag returns the correct Prisma fragment', () => {
      const fragment = whereTag('nature');
      expect(fragment).toEqual({
        mediaTags: {
          some: { tag: { name: { equals: 'nature', mode: 'insensitive' } } },
        },
      });
    });

    it('whereCountry returns OR with geoCountry and geoCountryCode', () => {
      const fragment = whereCountry('Costa Rica');
      const or = (fragment as any).OR as Array<Record<string, unknown>>;
      expect(or).toHaveLength(2);
      expect(or[0]).toHaveProperty('geoCountry');
      expect(or[1]).toHaveProperty('geoCountryCode');
    });

    it('whereLocality returns geoLocality contains', () => {
      const fragment = whereLocality('Heredia');
      expect(fragment).toEqual({ geoLocality: { contains: 'Heredia', mode: 'insensitive' } });
    });

    it('whereFavorite returns favorite flag', () => {
      expect(whereFavorite(true)).toEqual({ favorite: true });
      expect(whereFavorite(false)).toEqual({ favorite: false });
    });

    it('whereType casts value to type field', () => {
      expect((whereType('photo') as any).type).toBe('photo');
    });
  });
});

// ---------------------------------------------------------------------------
// buildWhereFromFields
// ---------------------------------------------------------------------------
describe('buildWhereFromFields', () => {
  it('always includes circleId and deletedAt:null', () => {
    const where = buildWhereFromFields(CIRCLE_ID, {});
    expect(where).toMatchObject({ circleId: CIRCLE_ID, deletedAt: null });
  });

  it('returns only baseline for empty filters', () => {
    const where = buildWhereFromFields(CIRCLE_ID, {});
    expect(Object.keys(where).sort()).toEqual(['circleId', 'deletedAt'].sort());
  });

  it('throws BadRequestException for unknown filter key', () => {
    expect(() =>
      buildWhereFromFields(CIRCLE_ID, { badKey: 'x' }),
    ).toThrow(BadRequestException);
  });

  it('throws BadRequestException listing the unknown key in the message', () => {
    expect(() =>
      buildWhereFromFields(CIRCLE_ID, { unknownField: 'y' }),
    ).toThrow(/unknownField/);
  });

  it('applies tag filter via registry', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { tag: 'sunset' });
    expect(where).toMatchObject({
      mediaTags: { some: { tag: { name: { equals: 'sunset', mode: 'insensitive' } } } },
    });
  });

  it('applies country filter via registry', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { country: 'CR' });
    expect(Array.isArray((where as any).OR)).toBe(true);
  });

  it('applies locality filter via registry', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { locality: 'San José' });
    expect((where as any).geoLocality).toBeDefined();
  });

  it('applies type filter via registry', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { type: 'video' });
    expect((where as any).type).toBe('video');
  });

  it('applies favorite filter via registry', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { favorite: true });
    expect((where as any).favorite).toBe(true);
  });

  it('skips null/undefined filter values', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { type: undefined as any, tag: null as any });
    expect((where as any).type).toBeUndefined();
    expect((where as any).mediaTags).toBeUndefined();
  });

  it('applies missingCapturedAt:true filter via registry', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { missingCapturedAt: true });
    expect((where as any).capturedAt).toBeNull();
  });

  it('applies missingCapturedAt:false filter via registry', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { missingCapturedAt: false });
    expect((where as any).capturedAt).toEqual({ not: null });
  });

  it('applies missingCamera:true filter via registry', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { missingCamera: true });
    expect((where as any).cameraMake).toBeNull();
    expect((where as any).cameraModel).toBeNull();
  });

  it('applies missingCamera:false filter via registry (OR clause)', () => {
    const where = buildWhereFromFields(CIRCLE_ID, { missingCamera: false });
    const or = (where as any).OR as unknown[];
    expect(Array.isArray(or)).toBe(true);
    expect(or).toEqual([{ cameraMake: { not: null } }, { cameraModel: { not: null } }]);
  });

  describe('non-drift guarantee: buildMediaWhere and buildWhereFromFields agree', () => {
    it('tag filter produces identical output from both functions', () => {
      const fromBuilder = buildMediaWhere(CIRCLE_ID, { tag: 'landscape' });
      const fromRegistry = buildWhereFromFields(CIRCLE_ID, { tag: 'landscape' });
      expect(fromRegistry).toEqual(fromBuilder);
    });

    it('country filter produces identical output from both functions', () => {
      const fromBuilder = buildMediaWhere(CIRCLE_ID, { country: 'CR' });
      const fromRegistry = buildWhereFromFields(CIRCLE_ID, { country: 'CR' });
      expect(fromRegistry).toEqual(fromBuilder);
    });

    it('type filter produces identical output from both functions', () => {
      const fromBuilder = buildMediaWhere(CIRCLE_ID, { type: 'photo' });
      const fromRegistry = buildWhereFromFields(CIRCLE_ID, { type: 'photo' });
      expect(fromRegistry).toEqual(fromBuilder);
    });

    it('favorite filter produces identical output from both functions', () => {
      const fromBuilder = buildMediaWhere(CIRCLE_ID, { favorite: true });
      const fromRegistry = buildWhereFromFields(CIRCLE_ID, { favorite: true });
      expect(fromRegistry).toEqual(fromBuilder);
    });

    it('locality filter produces identical output from both functions', () => {
      const fromBuilder = buildMediaWhere(CIRCLE_ID, { locality: 'Heredia' });
      const fromRegistry = buildWhereFromFields(CIRCLE_ID, { locality: 'Heredia' });
      expect(fromRegistry).toEqual(fromBuilder);
    });

    it('missingCapturedAt:true produces identical output from both functions', () => {
      const fromBuilder = buildMediaWhere(CIRCLE_ID, { missingCapturedAt: true });
      const fromRegistry = buildWhereFromFields(CIRCLE_ID, { missingCapturedAt: true });
      expect(fromRegistry).toEqual(fromBuilder);
    });

    it('missingCapturedAt:false produces identical output from both functions', () => {
      const fromBuilder = buildMediaWhere(CIRCLE_ID, { missingCapturedAt: false });
      const fromRegistry = buildWhereFromFields(CIRCLE_ID, { missingCapturedAt: false });
      expect(fromRegistry).toEqual(fromBuilder);
    });

    it('missingCamera:true produces identical output from both functions', () => {
      const fromBuilder = buildMediaWhere(CIRCLE_ID, { missingCamera: true });
      const fromRegistry = buildWhereFromFields(CIRCLE_ID, { missingCamera: true });
      expect(fromRegistry).toEqual(fromBuilder);
    });

    it('missingCamera:false produces identical output from both functions', () => {
      const fromBuilder = buildMediaWhere(CIRCLE_ID, { missingCamera: false });
      const fromRegistry = buildWhereFromFields(CIRCLE_ID, { missingCamera: false });
      expect(fromRegistry).toEqual(fromBuilder);
    });
  });

  describe('SEARCHABLE_FIELDS registry integrity', () => {
    it('contains known field keys', () => {
      const keys = SEARCHABLE_FIELDS.map((f) => f.key);
      expect(keys).toContain('tag');
      expect(keys).toContain('type');
      expect(keys).toContain('country');
      expect(keys).toContain('favorite');
      expect(keys).toContain('locality');
      expect(keys).toContain('cameraMake');
      expect(keys).toContain('missingCapturedAt');
      expect(keys).toContain('missingCamera');
    });

    it('every field has key, label, type, description, and buildWhere', () => {
      for (const field of SEARCHABLE_FIELDS) {
        expect(typeof field.key).toBe('string');
        expect(typeof field.label).toBe('string');
        expect(typeof field.type).toBe('string');
        expect(typeof field.description).toBe('string');
        expect(typeof field.buildWhere).toBe('function');
      }
    });

    it('contains the people field with type person-set and optionsSource', () => {
      const keys = SEARCHABLE_FIELDS.map((f) => f.key);
      expect(keys).toContain('people');

      const peopleField = SEARCHABLE_FIELDS.find((f) => f.key === 'people')!;
      expect(peopleField.type).toBe('person-set');
      expect(peopleField.optionsSource).toBe('people');
    });
  });
});

// ---------------------------------------------------------------------------
// whereNoFaces — standalone helper
// ---------------------------------------------------------------------------
import { whereNoFaces } from './media-where.builder';

describe('whereNoFaces', () => {
  it('returns { faces: { none: {} } } when value is true', () => {
    expect(whereNoFaces(true)).toEqual({ faces: { none: {} } });
  });

  it('returns {} when value is false', () => {
    expect(whereNoFaces(false)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// whereMissingCapturedAt — standalone helper
// ---------------------------------------------------------------------------
import { whereMissingCapturedAt, whereMissingCamera } from './media-where.builder';

describe('whereMissingCapturedAt', () => {
  it('returns { capturedAt: null } when value is true', () => {
    expect(whereMissingCapturedAt(true)).toEqual({ capturedAt: null });
  });

  it('returns { capturedAt: { not: null } } when value is false', () => {
    expect(whereMissingCapturedAt(false)).toEqual({ capturedAt: { not: null } });
  });
});

// ---------------------------------------------------------------------------
// whereMissingCamera — standalone helper
// ---------------------------------------------------------------------------
describe('whereMissingCamera', () => {
  it('returns { cameraMake: null, cameraModel: null } when value is true', () => {
    expect(whereMissingCamera(true)).toEqual({ cameraMake: null, cameraModel: null });
  });

  it('returns OR clause with not-null entries when value is false', () => {
    expect(whereMissingCamera(false)).toEqual({
      OR: [{ cameraMake: { not: null } }, { cameraModel: { not: null } }],
    });
  });
});

// ---------------------------------------------------------------------------
// missingCapturedAt field in SEARCHABLE_FIELDS registry
// ---------------------------------------------------------------------------
describe('SEARCHABLE_FIELDS — missingCapturedAt field', () => {
  function getField() {
    return SEARCHABLE_FIELDS.find((f) => f.key === 'missingCapturedAt')!;
  }

  it('contains the missingCapturedAt key', () => {
    const keys = SEARCHABLE_FIELDS.map((f) => f.key);
    expect(keys).toContain('missingCapturedAt');
  });

  it('has label "Missing capture date"', () => {
    const field = getField();
    expect(field.label).toBe('Missing capture date');
  });

  it('has type "boolean"', () => {
    const field = getField();
    expect(field).toBeDefined();
    expect(field.type).toBe('boolean');
  });

  it('buildWhere(true) returns { capturedAt: null }', () => {
    const field = getField();
    expect(field.buildWhere(true)).toEqual({ capturedAt: null });
  });

  it('buildWhere(false) returns { capturedAt: { not: null } }', () => {
    const field = getField();
    expect(field.buildWhere(false)).toEqual({ capturedAt: { not: null } });
  });
});

// ---------------------------------------------------------------------------
// missingCamera field in SEARCHABLE_FIELDS registry
// ---------------------------------------------------------------------------
describe('SEARCHABLE_FIELDS — missingCamera field', () => {
  function getField() {
    return SEARCHABLE_FIELDS.find((f) => f.key === 'missingCamera')!;
  }

  it('contains the missingCamera key', () => {
    const keys = SEARCHABLE_FIELDS.map((f) => f.key);
    expect(keys).toContain('missingCamera');
  });

  it('has label "Missing camera info"', () => {
    const field = getField();
    expect(field.label).toBe('Missing camera info');
  });

  it('has type "boolean"', () => {
    const field = getField();
    expect(field).toBeDefined();
    expect(field.type).toBe('boolean');
  });

  it('buildWhere(true) returns { cameraMake: null, cameraModel: null }', () => {
    const field = getField();
    expect(field.buildWhere(true)).toEqual({ cameraMake: null, cameraModel: null });
  });

  it('buildWhere(false) returns the OR clause', () => {
    const field = getField();
    expect(field.buildWhere(false)).toEqual({
      OR: [{ cameraMake: { not: null } }, { cameraModel: { not: null } }],
    });
  });
});

// ---------------------------------------------------------------------------
// noFaces field in SEARCHABLE_FIELDS registry
// ---------------------------------------------------------------------------
describe('SEARCHABLE_FIELDS — noFaces field', () => {
  it('contains the noFaces key', () => {
    const keys = SEARCHABLE_FIELDS.map((f) => f.key);
    expect(keys).toContain('noFaces');
  });

  it('noFaces field has type "boolean"', () => {
    const field = SEARCHABLE_FIELDS.find((f) => f.key === 'noFaces')!;
    expect(field).toBeDefined();
    expect(field.type).toBe('boolean');
  });

  it('noFaces buildWhere returns faces.none clause for true', () => {
    const field = SEARCHABLE_FIELDS.find((f) => f.key === 'noFaces')!;
    expect(field.buildWhere(true)).toEqual({ faces: { none: {} } });
  });

  it('noFaces buildWhere returns {} for false', () => {
    const field = SEARCHABLE_FIELDS.find((f) => f.key === 'noFaces')!;
    expect(field.buildWhere(false)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// wherePeople — standalone helper
// ---------------------------------------------------------------------------
import { wherePeople } from './media-where.builder';

describe('wherePeople', () => {
  const ID_A = '11111111-1111-1111-1111-111111111111';
  const ID_B = '22222222-2222-2222-2222-222222222222';

  it('returns {} for an empty ids array', () => {
    expect(wherePeople([])).toEqual({});
  });

  it('returns {} for an empty ids array with explicit any mode', () => {
    expect(wherePeople([], 'any')).toEqual({});
  });

  it('returns {} for an empty ids array with explicit all mode', () => {
    expect(wherePeople([], 'all')).toEqual({});
  });

  it('defaults to all mode when mode is omitted', () => {
    const result = wherePeople([ID_A]) as any;
    // 'all' mode produces AND array
    expect(Array.isArray(result.AND)).toBe(true);
    expect(result.AND).toHaveLength(1);
  });

  it('produces faces.some.personId.in for any mode with multiple ids', () => {
    const result = wherePeople([ID_A, ID_B], 'any') as any;
    expect(result).toEqual({
      faces: { some: { personId: { in: [ID_A, ID_B] } } },
    });
  });

  it('produces faces.some.personId.in for any mode with a single id', () => {
    const result = wherePeople([ID_A], 'any') as any;
    expect(result).toEqual({
      faces: { some: { personId: { in: [ID_A] } } },
    });
  });

  it('produces AND array of faces.some for all mode with multiple ids', () => {
    const result = wherePeople([ID_A, ID_B], 'all') as any;
    expect(result).toEqual({
      AND: [
        { faces: { some: { personId: ID_A } } },
        { faces: { some: { personId: ID_B } } },
      ],
    });
  });

  it('produces a single-element AND array for all mode with one id', () => {
    const result = wherePeople([ID_A], 'all') as any;
    expect(result).toEqual({
      AND: [{ faces: { some: { personId: ID_A } } }],
    });
  });

  it('filters out empty-string ids', () => {
    const result = wherePeople(['', ID_A, '  '], 'any') as any;
    expect(result).toEqual({
      faces: { some: { personId: { in: [ID_A] } } },
    });
  });

  it('filters out non-string ids (garbage input) and returns {} if none remain', () => {
    const result = wherePeople([42 as any, null as any, undefined as any], 'any');
    expect(result).toEqual({});
  });

  it('filters out non-string ids but keeps valid ones', () => {
    const result = wherePeople([42 as any, ID_A], 'any') as any;
    expect(result).toEqual({
      faces: { some: { personId: { in: [ID_A] } } },
    });
  });
});

// ---------------------------------------------------------------------------
// people field buildWhere via registry
// ---------------------------------------------------------------------------
describe('SEARCHABLE_FIELDS people field buildWhere', () => {
  const ID_A = '11111111-1111-1111-1111-111111111111';
  const ID_B = '22222222-2222-2222-2222-222222222222';

  function getPeopleField() {
    return SEARCHABLE_FIELDS.find((f) => f.key === 'people')!;
  }

  it('returns {} when value is undefined', () => {
    const field = getPeopleField();
    expect(field.buildWhere(undefined)).toEqual({});
  });

  it('returns {} when value is null', () => {
    const field = getPeopleField();
    expect(field.buildWhere(null)).toEqual({});
  });

  it('returns {} when ids is empty array', () => {
    const field = getPeopleField();
    expect(field.buildWhere({ ids: [] })).toEqual({});
  });

  it('returns {} when ids is not an array', () => {
    const field = getPeopleField();
    expect(field.buildWhere({ ids: 'not-an-array' })).toEqual({});
  });

  it('defaults mode to all when mode is omitted', () => {
    const field = getPeopleField();
    const result = field.buildWhere({ ids: [ID_A] }) as any;
    // all mode → AND array
    expect(Array.isArray(result.AND)).toBe(true);
  });

  it('uses all mode when mode is all', () => {
    const field = getPeopleField();
    const result = field.buildWhere({ ids: [ID_A, ID_B], mode: 'all' }) as any;
    expect(result).toEqual({
      AND: [
        { faces: { some: { personId: ID_A } } },
        { faces: { some: { personId: ID_B } } },
      ],
    });
  });

  it('uses any mode when mode is any', () => {
    const field = getPeopleField();
    const result = field.buildWhere({ ids: [ID_A, ID_B], mode: 'any' }) as any;
    expect(result).toEqual({
      faces: { some: { personId: { in: [ID_A, ID_B] } } },
    });
  });

  it('falls back to all mode for an unrecognised mode value', () => {
    const field = getPeopleField();
    const result = field.buildWhere({ ids: [ID_A], mode: 'unknown' }) as any;
    expect(Array.isArray(result.AND)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DTO validation — peopleFilterValueSchema and searchQuerySchema
// ---------------------------------------------------------------------------
import { peopleFilterValueSchema, searchQuerySchema } from './dto/search-query.dto';

describe('peopleFilterValueSchema', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
  const VALID_UUID_2 = '550e8400-e29b-41d4-a716-446655440001';

  it('accepts valid {ids:[uuid], mode:"all"}', () => {
    const result = peopleFilterValueSchema.safeParse({ ids: [VALID_UUID], mode: 'all' });
    expect(result.success).toBe(true);
  });

  it('accepts valid {ids:[uuid], mode:"any"}', () => {
    const result = peopleFilterValueSchema.safeParse({ ids: [VALID_UUID], mode: 'any' });
    expect(result.success).toBe(true);
  });

  it('accepts multiple valid UUIDs', () => {
    const result = peopleFilterValueSchema.safeParse({
      ids: [VALID_UUID, VALID_UUID_2],
      mode: 'all',
    });
    expect(result.success).toBe(true);
  });

  it('defaults mode to "all" when mode is omitted', () => {
    const result = peopleFilterValueSchema.safeParse({ ids: [VALID_UUID] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('all');
    }
  });

  it('rejects when ids is an empty array (min 1)', () => {
    const result = peopleFilterValueSchema.safeParse({ ids: [], mode: 'all' });
    expect(result.success).toBe(false);
  });

  it('rejects when ids contains a non-UUID string', () => {
    const result = peopleFilterValueSchema.safeParse({ ids: ['not-a-uuid'], mode: 'all' });
    expect(result.success).toBe(false);
  });

  it('rejects when mode is an invalid value', () => {
    const result = peopleFilterValueSchema.safeParse({ ids: [VALID_UUID], mode: 'both' });
    expect(result.success).toBe(false);
  });

  it('rejects when ids is missing entirely', () => {
    const result = peopleFilterValueSchema.safeParse({ mode: 'all' });
    expect(result.success).toBe(false);
  });
});

describe('searchQuerySchema — people filter validation', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

  function makeBaseQuery(overrides: Record<string, unknown> = {}) {
    return {
      circleId: '550e8400-e29b-41d4-a716-446655440099',
      filters: {},
      ...overrides,
    };
  }

  it('accepts a valid people filter within filters', () => {
    const result = searchQuerySchema.safeParse(
      makeBaseQuery({ filters: { people: { ids: [VALID_UUID], mode: 'all' } } }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts omitted people filter (no people key in filters)', () => {
    const result = searchQuerySchema.safeParse(makeBaseQuery({ filters: {} }));
    expect(result.success).toBe(true);
  });

  it('rejects people filter with empty ids array', () => {
    const result = searchQuerySchema.safeParse(
      makeBaseQuery({ filters: { people: { ids: [], mode: 'all' } } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects people filter with an invalid UUID in ids', () => {
    const result = searchQuerySchema.safeParse(
      makeBaseQuery({ filters: { people: { ids: ['not-a-uuid'] } } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects people filter with an invalid mode', () => {
    const result = searchQuerySchema.safeParse(
      makeBaseQuery({ filters: { people: { ids: [VALID_UUID], mode: 'wrong' } } }),
    );
    expect(result.success).toBe(false);
  });
});
