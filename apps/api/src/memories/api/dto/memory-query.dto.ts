import { createZodDto } from 'nestjs-zod';
import { memoryListQuerySchema, memoryFeedQuerySchema } from '@marinoscar/memoriahub-contract/memories';

export { memoryListQuerySchema, memoryFeedQuerySchema };

export class MemoryListQueryDto extends createZodDto(memoryListQuerySchema) {}

export class MemoryFeedQueryDto extends createZodDto(memoryFeedQuerySchema) {}
