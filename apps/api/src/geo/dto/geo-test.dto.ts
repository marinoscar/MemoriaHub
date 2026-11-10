import { createZodDto } from 'nestjs-zod';
import { testGeoProviderSchema } from '@marinoscar/memoriahub-contract/location';

export { testGeoProviderSchema };

export class TestGeoProviderDto extends createZodDto(testGeoProviderSchema) {}
