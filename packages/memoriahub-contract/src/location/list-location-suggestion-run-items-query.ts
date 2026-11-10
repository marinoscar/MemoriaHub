import { z } from 'zod';


/**
 * GET /api/location-suggestion-runs/:id/items query params.
 *
 * @stability experimental
 */
export const listLocationSuggestionRunItemsQuerySchema = z.object({
  status: z.enum(['matched', 'processing', 'applied', 'failed', 'skipped']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The parsed value of {@link listLocationSuggestionRunItemsQuerySchema}.
 *
 * @stability experimental
 */
export type ListLocationSuggestionRunItemsQuery = z.infer<typeof listLocationSuggestionRunItemsQuerySchema>;
