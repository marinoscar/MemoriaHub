import { createZodDto } from 'nestjs-zod';
import { locationSuggestionQuerySchema } from '@marinoscar/memoriahub-contract/location';

export { locationSuggestionQuerySchema };

export class LocationSuggestionQueryDto extends createZodDto(locationSuggestionQuerySchema) {}
