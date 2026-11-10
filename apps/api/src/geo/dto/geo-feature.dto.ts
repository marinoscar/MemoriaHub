import { createZodDto } from 'nestjs-zod';
import { setGeoReverseProviderSchema } from '@marinoscar/memoriahub-contract/location';

export { setGeoReverseProviderSchema };

export class SetGeoReverseProviderDto extends createZodDto(setGeoReverseProviderSchema) {}
