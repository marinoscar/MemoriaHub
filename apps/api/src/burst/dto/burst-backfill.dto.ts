import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const schema = z.object({
  circleId: z.string().uuid(),
  force: z.boolean().optional().default(false),
});

export class BurstBackfillDto extends createZodDto(schema) {}
