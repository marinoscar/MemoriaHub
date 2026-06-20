import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const schema = z
  .object({
    circleId: z.string().uuid(),
    force: z.boolean().optional().default(false),
    /**
     * ISO-8601 date or datetime (inclusive lower bound for capturedAt).
     * Example: "2024-01-01" or "2024-01-01T00:00:00Z"
     */
    from: z.string().datetime({ offset: true }).optional(),
    /**
     * ISO-8601 date or datetime (inclusive upper bound for capturedAt).
     * Example: "2024-12-31" or "2024-12-31T23:59:59Z"
     */
    to: z.string().datetime({ offset: true }).optional(),
  })
  .refine(
    (data) => {
      if (data.from && data.to) {
        return new Date(data.from) <= new Date(data.to);
      }
      return true;
    },
    { message: '`from` must not be after `to`', path: ['from'] },
  );

export class BurstBackfillDto extends createZodDto(schema) {}
