import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Body for the async bulk accept/reject run start endpoints
 * (POST /api/media/location-suggestions/bulk-accept and bulk-reject).
 *
 * `threshold` is on a 0-100 scale (matching burst.autoResolveThreshold); the
 * run service converts it to a 0-1 confidence floor (threshold/100) at
 * evaluation time.
 */
const schema = z.object({
  circleId: z.string().uuid(),
  threshold: z.coerce.number().int().min(0).max(100),
});

export class BulkResolveLocationSuggestionsDto extends createZodDto(schema) {}
