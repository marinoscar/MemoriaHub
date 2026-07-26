import { burstQuerySchema } from './burst-query.dto';

const CIRCLE_ID = '11111111-1111-4111-8111-111111111111';

describe('burstQuerySchema', () => {
  describe('sortBy parameter', () => {
    it('applies the default value of capturedAt when omitted', () => {
      const result = burstQuerySchema.parse({ circleId: CIRCLE_ID });

      expect(result.sortBy).toBe('capturedAt');
    });

    it('accepts all valid sortBy values', () => {
      expect(burstQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'capturedAt' }).sortBy).toBe(
        'capturedAt',
      );
      expect(burstQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'confidence' }).sortBy).toBe(
        'confidence',
      );
      expect(burstQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'mediaCount' }).sortBy).toBe(
        'mediaCount',
      );
    });

    it('rejects an unsupported sortBy value', () => {
      expect(() => burstQuerySchema.parse({ circleId: CIRCLE_ID, sortBy: 'bogus' })).toThrow();
    });
  });

  describe('sortOrder parameter', () => {
    it('applies the default value of asc when omitted', () => {
      const result = burstQuerySchema.parse({ circleId: CIRCLE_ID });

      expect(result.sortOrder).toBe('asc');
    });

    it('accepts both valid sortOrder values', () => {
      expect(burstQuerySchema.parse({ circleId: CIRCLE_ID, sortOrder: 'asc' }).sortOrder).toBe('asc');
      expect(burstQuerySchema.parse({ circleId: CIRCLE_ID, sortOrder: 'desc' }).sortOrder).toBe('desc');
    });

    it('rejects an unsupported sortOrder value (case-sensitive)', () => {
      expect(() => burstQuerySchema.parse({ circleId: CIRCLE_ID, sortOrder: 'ASC' })).toThrow();
    });
  });

  describe('combined parameters', () => {
    it('parses sortBy and sortOrder together with the other defaults', () => {
      const result = burstQuerySchema.parse({
        circleId: CIRCLE_ID,
        sortBy: 'confidence',
        sortOrder: 'desc',
      });

      expect(result).toMatchObject({
        circleId: CIRCLE_ID,
        status: 'pending',
        page: 1,
        pageSize: 20,
        sortBy: 'confidence',
        sortOrder: 'desc',
      });
    });
  });

  describe('circleId requirement (unaffected by this change)', () => {
    it('rejects a request missing circleId', () => {
      expect(() => burstQuerySchema.parse({})).toThrow();
    });
  });
});
