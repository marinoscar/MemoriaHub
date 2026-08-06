import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { ApiPropertyOptional } from '@nestjs/swagger';

// DELIBERATELY has NO top-level `.default({})`, unlike the other all-optional
// body schemas fixed in issue #289 — do not add one in a future sweep.
//
// Every key here is optional, so this schema pattern-matches the #289 fix, but
// the `.refine()` below is what makes a bodyless request semantically INVALID:
// a backup must name a circle or opt into all of them. `.default({})` BYPASSES
// a top-level refine for the default value, so adding it would silently ACCEPT
// an empty body that this endpoint must reject. See app.module.ts for the rule.
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
