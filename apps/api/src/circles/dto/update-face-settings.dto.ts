import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

export const updateFaceSettingsSchema = z.object({
  enabled: z.boolean(),
});

export class UpdateFaceSettingsDto extends createZodDto(updateFaceSettingsSchema) {
  @ApiProperty({ description: 'Enable or disable face recognition for this circle' })
  enabled!: boolean;
}
