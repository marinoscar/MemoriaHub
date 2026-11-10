import { z } from 'zod';


/**
 * Wire schema `acceptLocationSuggestionSchema`.
 *
 * @stability experimental
 */
export const acceptLocationSuggestionSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  // .default({}) so a bodyless POST (accept unmodified) parses as {} — see
  // issue #289 (app.module.ts).
}).default({});

/**
 * The parsed value of {@link acceptLocationSuggestionSchema}.
 *
 * @stability experimental
 */
export type AcceptLocationSuggestion = z.infer<typeof acceptLocationSuggestionSchema>;
