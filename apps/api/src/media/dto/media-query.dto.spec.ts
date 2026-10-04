import { mediaQuerySchema } from './media-query.dto';

describe('mediaQuerySchema sortBy', () => {
  const base = { circleId: '3f9c1c6e-8f0e-4a55-9d3b-1b6a2f1d7c11' };

  it("accepts sortBy 'displayAt'", () => {
    const parsed = mediaQuerySchema.parse({ ...base, sortBy: 'displayAt' });
    expect(parsed.sortBy).toBe('displayAt');
  });

  it.each(['capturedAt', 'importedAt', 'createdAt'])('still accepts %s', (sortBy) => {
    expect(mediaQuerySchema.parse({ ...base, sortBy }).sortBy).toBe(sortBy);
  });

  it("defaults sortBy to 'capturedAt' so existing clients are unchanged", () => {
    expect(mediaQuerySchema.parse(base).sortBy).toBe('capturedAt');
  });

  it('rejects an unknown sortBy value', () => {
    expect(mediaQuerySchema.safeParse({ ...base, sortBy: 'bogus' }).success).toBe(false);
  });
});
