import { createZodDto } from 'nestjs-zod';
import { listRunsQuerySchema } from '@marinoscar/memoriahub-contract/workflows';

export { listRunsQuerySchema };

export class ListRunsQueryDto extends createZodDto(listRunsQuerySchema) {}
