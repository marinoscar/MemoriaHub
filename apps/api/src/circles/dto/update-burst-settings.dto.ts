import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

export const updateBurstSettingsSchema = z.object({ enabled: z.boolean() });

export class UpdateBurstSettingsDto extends createZodDto(updateBurstSettingsSchema) {
  @ApiProperty({ description: 'Enable or disable burst detection for this circle' })
  enabled!: boolean;
}
