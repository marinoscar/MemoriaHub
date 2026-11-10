import { createZodDto } from 'nestjs-zod';
import { acceptLocationSuggestionSchema } from '@marinoscar/memoriahub-contract/location';


export class AcceptLocationSuggestionDto extends createZodDto(acceptLocationSuggestionSchema) {}
