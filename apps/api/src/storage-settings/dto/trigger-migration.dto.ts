import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const TriggerMigrationSchema = z.object({
  sourceProvider: z.string().min(1),
  targetProvider: z.string().min(1),
});

export class TriggerMigrationDto extends createZodDto(TriggerMigrationSchema) {}
