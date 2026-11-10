import { createZodDto } from 'nestjs-zod';
import { upsertFaceCredentialsSchema, testFaceProviderSchema, setDetectionFeatureSchema } from '@marinoscar/memoriahub-contract/face';

export { upsertFaceCredentialsSchema, testFaceProviderSchema, setDetectionFeatureSchema };

/**
 * The `UpsertFaceCredentialsDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class UpsertFaceCredentialsDto extends createZodDto(upsertFaceCredentialsSchema) {}

/**
 * The `TestFaceProviderDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class TestFaceProviderDto extends createZodDto(testFaceProviderSchema) {}

/**
 * The `SetDetectionFeatureDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class SetDetectionFeatureDto extends createZodDto(setDetectionFeatureSchema) {}
