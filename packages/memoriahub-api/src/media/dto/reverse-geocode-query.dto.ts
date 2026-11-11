import { createZodDto } from 'nestjs-zod';
import { reverseGeocodeQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { reverseGeocodeQuerySchema };

/**
 * The `ReverseGeocodeQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ReverseGeocodeQueryDto extends createZodDto(reverseGeocodeQuerySchema) {}
