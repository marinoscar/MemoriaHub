import { createZodDto } from 'nestjs-zod';
import { memoryMyStateSchema, memoryDetailMyStateSchema, memoryCardSchema, memoryFeedCardSchema, memoryListSchema, memoryFeedSchema, memoryDetailItemSchema, memoryDetailSchema, saveMemoryAlbumResultSchema } from '@marinoscar/memoriahub-contract/memories';

export { memoryMyStateSchema, memoryDetailMyStateSchema, memoryCardSchema, memoryFeedCardSchema, memoryListSchema, memoryFeedSchema, memoryDetailItemSchema, memoryDetailSchema, saveMemoryAlbumResultSchema };

export class MemoryCardDto extends createZodDto(memoryCardSchema) {}

export class MemoryFeedCardDto extends createZodDto(memoryFeedCardSchema) {}

export class MemoryListDto extends createZodDto(memoryListSchema) {}

export class MemoryFeedDto extends createZodDto(memoryFeedSchema) {}

export class MemoryDetailItemDto extends createZodDto(memoryDetailItemSchema) {}

export class MemoryDetailDto extends createZodDto(memoryDetailSchema) {}

export class SaveMemoryAlbumResultDto extends createZodDto(saveMemoryAlbumResultSchema) {}
