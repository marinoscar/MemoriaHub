import { createZodDto } from 'nestjs-zod';
import { mergePeopleSchema } from '@marinoscar/memoriahub-contract/face';
import { ApiProperty } from '@nestjs/swagger';

export { mergePeopleSchema };

/**
 * The `MergePeopleDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class MergePeopleDto extends createZodDto(mergePeopleSchema) {
  @ApiProperty({ description: 'Person to merge from (will be soft-deleted)' })
  sourceId!: string;

  @ApiProperty({ description: 'Person to merge into (survives)' })
  targetId!: string;
}
