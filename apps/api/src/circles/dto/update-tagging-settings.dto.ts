import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

export const updateTaggingSettingsSchema = z.object({
  enabled: z.boolean(),
});

export class UpdateTaggingSettingsDto extends createZodDto(updateTaggingSettingsSchema) {
  @ApiProperty({ description: 'Enable or disable auto-tagging for this circle' })
  enabled!: boolean;
}
