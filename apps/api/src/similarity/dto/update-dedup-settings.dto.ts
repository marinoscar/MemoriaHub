import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

export const updateDedupSettingsSchema = z.object({ enabled: z.boolean() });

export class UpdateDedupSettingsDto extends createZodDto(updateDedupSettingsSchema) {
  @ApiProperty({ description: 'Enable or disable visual deduplication for this circle' })
  enabled!: boolean;
}
