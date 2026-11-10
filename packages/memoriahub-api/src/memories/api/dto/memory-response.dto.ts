import { createZodDto } from 'nestjs-zod';
import { memoryMyStateSchema, memoryDetailMyStateSchema, memoryCardSchema, memoryFeedCardSchema, memoryListSchema, memoryFeedSchema, memoryDetailItemSchema, memoryDetailSchema, saveMemoryAlbumResultSchema } from '@marinoscar/memoriahub-contract/memories';

export { memoryMyStateSchema, memoryDetailMyStateSchema, memoryCardSchema, memoryFeedCardSchema, memoryListSchema, memoryFeedSchema, memoryDetailItemSchema, memoryDetailSchema, saveMemoryAlbumResultSchema };

/** MemoryCardDto: memory card dto. @stability experimental */
export class MemoryCardDto extends createZodDto(memoryCardSchema) {}

/** MemoryFeedCardDto: memory feed card dto. @stability experimental */
export class MemoryFeedCardDto extends createZodDto(memoryFeedCardSchema) {}

/** MemoryListDto: memory list dto. @stability experimental */
export class MemoryListDto extends createZodDto(memoryListSchema) {}

/** MemoryFeedDto: memory feed dto. @stability experimental */
export class MemoryFeedDto extends createZodDto(memoryFeedSchema) {}

/** MemoryDetailItemDto: memory detail item dto. @stability experimental */
export class MemoryDetailItemDto extends createZodDto(memoryDetailItemSchema) {}

/** MemoryDetailDto: memory detail dto. @stability experimental */
export class MemoryDetailDto extends createZodDto(memoryDetailSchema) {}

/** SaveMemoryAlbumResultDto: save memory album result dto. @stability experimental */
export class SaveMemoryAlbumResultDto extends createZodDto(saveMemoryAlbumResultSchema) {}
