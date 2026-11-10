import { createZodDto } from 'nestjs-zod';
import { listLocationSuggestionRunItemsQuerySchema } from '@marinoscar/memoriahub-contract/location';

export { listLocationSuggestionRunItemsQuerySchema };

export class ListLocationSuggestionRunItemsQueryDto extends createZodDto(listLocationSuggestionRunItemsQuerySchema) {}
