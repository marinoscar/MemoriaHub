import { createZodDto } from 'nestjs-zod';
import { memoryListQuerySchema, memoryFeedQuerySchema } from '@marinoscar/memoriahub-contract/memories';

export { memoryListQuerySchema, memoryFeedQuerySchema };

/** MemoryListQueryDto: memory list query dto. @stability experimental */
export class MemoryListQueryDto extends createZodDto(memoryListQuerySchema) {}

/** MemoryFeedQueryDto: memory feed query dto. @stability experimental */
export class MemoryFeedQueryDto extends createZodDto(memoryFeedQuerySchema) {}
