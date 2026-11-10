import { createZodDto } from 'nestjs-zod';
import { bulkResolveLocationSuggestionsSchema } from '@marinoscar/memoriahub-contract/location';


export class BulkResolveLocationSuggestionsDto extends createZodDto(bulkResolveLocationSuggestionsSchema) {}
