import { createZodDto } from 'nestjs-zod';
import { reverseGeocodeQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { reverseGeocodeQuerySchema };

export class ReverseGeocodeQueryDto extends createZodDto(reverseGeocodeQuerySchema) {}
