import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

export const mergePeopleSchema = z
  .object({
    sourceId: z.string().uuid(),
    targetId: z.string().uuid(),
  })
  .refine((d) => d.sourceId !== d.targetId, {
    message: 'sourceId and targetId must be different',
    path: ['targetId'],
  });

export class MergePeopleDto extends createZodDto(mergePeopleSchema) {
  @ApiProperty({ description: 'Person to merge from (will be soft-deleted)' })
  sourceId!: string;

  @ApiProperty({ description: 'Person to merge into (survives)' })
  targetId!: string;
}
