import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Shape of the `people` filter value when sent in `filters.people`.
 * The deterministic search path receives UUIDs directly;
 * the AI agent path resolves names to IDs before calling runSearch.
 */
export const peopleFilterValueSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'people.ids must contain at least one UUID'),
  mode: z.enum(['all', 'any']).default('all'),
});

export type PeopleFilterValue = z.infer<typeof peopleFilterValueSchema>;

/**
 * Shape of the `near` filter value: a GPS point plus a radius in kilometres.
 */
export const nearFilterValueSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusKm: z.number().positive().max(20000),
});

export type NearFilterValue = z.infer<typeof nearFilterValueSchema>;

/**
 * `{ from?, to? }` shape for the two date-range filters (issue #446).
 *
 * Both bounds accept a full ISO 8601 timestamp OR a bare `YYYY-MM-DD`; the
 * calendar-date form is what the AI search agent emits and what a `<input
 * type="date">` produces, and its end-of-day semantics are applied downstream
 * in `media-where.builder`. Without this refinement `filters` was a bare
 * `z.record(z.string(), z.unknown())`, so a malformed `{from,to}` reached
 * `new Date()` unvalidated.
 */
export const dateRangeFilterValueSchema = z
  .object({
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (v) => v.from !== undefined || v.to !== undefined,
    'Provide at least one of { from, to }',
  )
  .refine(
    (v) =>
      [v.from, v.to].every((b) => b === undefined || !isNaN(new Date(b).getTime())),
    'Bounds must be an ISO 8601 date or datetime',
  );

export type DateRangeFilterValue = z.infer<typeof dateRangeFilterValueSchema>;

export const searchQuerySchema = z.object({
  circleId: z.string().uuid(),
  semanticQuery: z.string().min(1).max(512).optional(),
  filters: z
    .record(z.string(), z.unknown())
    .default({})
    .superRefine((filters, ctx) => {
      if ('people' in filters && filters['people'] !== undefined && filters['people'] !== null) {
        const result = peopleFilterValueSchema.safeParse(filters['people']);
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['people'],
            message: `Invalid people filter: ${result.error.issues.map((i) => i.message).join('; ')}`,
          });
        }
      }
      for (const key of ['capturedAt', 'uploadedAt'] as const) {
        if (key in filters && filters[key] !== undefined && filters[key] !== null) {
          const result = dateRangeFilterValueSchema.safeParse(filters[key]);
          if (!result.success) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `Invalid ${key} filter: ${result.error.issues.map((i) => i.message).join('; ')}`,
            });
          }
        }
      }
      if ('near' in filters && filters['near'] !== undefined && filters['near'] !== null) {
        const result = nearFilterValueSchema.safeParse(filters['near']);
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['near'],
            message: `Invalid near filter: ${result.error.issues.map((i) => i.message).join('; ')}`,
          });
        }
      }
    }),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['capturedAt', 'importedAt', 'createdAt']).default('capturedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export class SearchQueryDto extends createZodDto(searchQuerySchema) {}
