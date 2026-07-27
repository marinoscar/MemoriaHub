import { duplicateQuerySchema } from './duplicate-query.dto';

const CIRCLE_ID = '11111111-1111-4111-8111-111111111111';

describe('duplicateQuerySchema', () => {
  describe('sortBy parameter', () => {
    it('applies the default value of capturedAt when omitted', () => {
      const result = duplicateQuerySchema.parse({ circleId: CIRCLE_ID });

      expect(result.sortBy).toBe('capturedAt');
    });

    it('accepts all valid sortBy values', () => {
      expect(
        duplicateQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'capturedAt' }).sortBy,
      ).toBe('capturedAt');
      expect(
        duplicateQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'confidence' }).sortBy,
      ).toBe('confidence');
      expect(
        duplicateQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'mediaCount' }).sortBy,
      ).toBe('mediaCount');
    });

    it('rejects an unsupported sortBy value', () => {
      expect(() => duplicateQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'bogus' })).toThrow();
    });
  });

  describe('sortOrder parameter', () => {
    it('applies the default value of asc when omitted', () => {
      const result = duplicateQuerySchema.parse({ circleId: CIRCLE_ID });

      expect(result.sortOrder).toBe('asc');
    });

    it('accepts both valid sortOrder values', () => {
      expect(duplicateQuerySchema.parse({ circleId: CIRCLE_ID, sortOrder: 'asc' }).sortOrder).toBe(
        'asc',
      );
      expect(duplicateQuerySchema.parse({ circleId: CIRCLE_ID, sortOrder: 'desc' }).sortOrder).toBe(
        'desc',
      );
    });

    it('rejects an unsupported sortOrder value (case-sensitive)', () => {
      expect(() => duplicateQuerySchema.parse({ circleId: CIRCLE_ID, sortOrder: 'ASC' })).toThrow();
    });
  });

  describe('combined parameters', () => {
    it('parses sortBy, sortOrder, and kind together with the other defaults', () => {
      const result = duplicateQuerySchema.parse({
        circleId: CIRCLE_ID,
        kind: 'edited',
        sortBy: 'mediaCount',
        sortOrder: 'desc',
      });

      expect(result).toMatchObject({
        circleId: CIRCLE_ID,
        status: 'pending',
        kind: 'edited',
        page: 1,
        pageSize: 20,
        sortBy: 'mediaCount',
        sortOrder: 'desc',
      });
    });
  });

  describe('circleId requirement (unaffected by this change)', () => {
    it('rejects a request missing circleId', () => {
      expect(() => duplicateQuerySchema.parse({})).toThrow();
    });
  });
});
