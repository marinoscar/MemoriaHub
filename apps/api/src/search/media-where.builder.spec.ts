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
  });
});
