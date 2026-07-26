import { locationSuggestionQuerySchema } from './location-suggestion-query.dto';

const CIRCLE_ID = '11111111-1111-4111-8111-111111111111';

describe('locationSuggestionQuerySchema', () => {
  describe('sortBy parameter', () => {
    it('applies the default value of createdAt when omitted', () => {
      const result = locationSuggestionQuerySchema.parse({ circleId: CIRCLE_ID });

      expect(result.sortBy).toBe('createdAt');
    });

    it('accepts all valid sortBy values', () => {
      expect(
        locationSuggestionQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'createdAt' }).sortBy,
      ).toBe('createdAt');
      expect(
        locationSuggestionQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'confidence' }).sortBy,
      ).toBe('confidence');
    });

    it('rejects an unsupported sortBy value', () => {
      expect(() =>
        locationSuggestionQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'bogus' }),
      ).toThrow();
    });

    it('rejects "mediaCount" -- valid on the burst/duplicate schemas but not this one', () => {
      expect(() =>
        locationSuggestionQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'mediaCount' }),
      ).toThrow();
    });
  });

  describe('sortOrder parameter', () => {
    it('applies the default value of desc when omitted', () => {
      const result = locationSuggestionQuerySchema.parse({ circleId: CIRCLE_ID });

      expect(result.sortOrder).toBe('desc');
    });

    it('accepts both valid sortOrder values', () => {
      expect(
        locationSuggestionQuerySchema.parse({ circleId: CIRCLE_ID, sortOrder: 'asc' }).sortOrder,
      ).toBe('asc');
      expect(
        locationSuggestionQuerySchema.parse({ circleId: CIRCLE_ID, sortOrder: 'desc' }).sortOrder,
      ).toBe('desc');
    });

    it('rejects an unsupported sortOrder value (case-sensitive)', () => {
      expect(() =>
        locationSuggestionQuerySchema.parse({ circleId: CIRCLE_ID, sortOrder: 'ASC' }),
      ).toThrow();
    });
  });

  describe('combined parameters', () => {
    it('parses sortBy and sortOrder together with the other defaults', () => {
      const result = locationSuggestionQuerySchema.parse({
        circleId: CIRCLE_ID,
        sortBy: 'confidence',
        sortOrder: 'asc',
      });

      expect(result).toMatchObject({
        circleId: CIRCLE_ID,
        status: 'pending',
        page: 1,
        pageSize: 20,
        sortBy: 'confidence',
        sortOrder: 'asc',
      });
    });
  });

  describe('circleId requirement (unaffected by this change)', () => {
    it('rejects a request missing circleId', () => {
      expect(() => locationSuggestionQuerySchema.parse({})).toThrow();
    });
  });
});
