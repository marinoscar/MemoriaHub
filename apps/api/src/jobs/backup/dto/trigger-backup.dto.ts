import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const TriggerBackupSchema = z
  .object({
    circleId: z.string().uuid().optional(),
    all: z.boolean().optional(),
  })
  .refine((d) => d.circleId || d.all, {
    message: 'Provide either circleId or all:true',
  });

export class TriggerBackupDto extends createZodDto(TriggerBackupSchema) {
  @ApiPropertyOptional({ description: 'Circle ID to back up' })
  circleId?: string;

  @ApiPropertyOptional({ description: 'Back up all circles' })
  all?: boolean;
}
