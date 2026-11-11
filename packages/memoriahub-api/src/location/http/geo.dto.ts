import { createZodDto } from 'nestjs-zod';
import {
  backfillGeoSchema,
  setGeoReverseProviderSchema,
  testGeoProviderSchema,
  upsertGeoCredentialSchema,
} from '@marinoscar/memoriahub-contract/location';

/**
 * Body of `PUT /api/geo/credentials/:provider`.
 *
 * @stability experimental
 */
export class UpsertGeoCredentialDto extends createZodDto(upsertGeoCredentialSchema) {}

/**
 * Body of `PUT /api/geo/features/reverse`.
 *
 * @stability experimental
 */
export class SetGeoReverseProviderDto extends createZodDto(setGeoReverseProviderSchema) {}

/**
 * Body of `POST /api/geo/test`.
 *
 * @stability experimental
 */
export class TestGeoProviderDto extends createZodDto(testGeoProviderSchema) {}

/**
 * Body of `POST /api/admin/geocode/backfill`.
 *
 * @stability experimental
 */
export class BackfillGeoDto extends createZodDto(backfillGeoSchema) {}
