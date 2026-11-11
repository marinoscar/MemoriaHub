import { createZodDto } from 'nestjs-zod';
import { listTrashQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { listTrashQuerySchema };

export class ListTrashQueryDto extends createZodDto(listTrashQuerySchema) {}
