import { createZodDto } from 'nestjs-zod';
import { upsertFaceCredentialsSchema, testFaceProviderSchema, setDetectionFeatureSchema } from '@marinoscar/memoriahub-contract/face';

export { upsertFaceCredentialsSchema, testFaceProviderSchema, setDetectionFeatureSchema };

export class UpsertFaceCredentialsDto extends createZodDto(upsertFaceCredentialsSchema) {}

export class TestFaceProviderDto extends createZodDto(testFaceProviderSchema) {}

export class SetDetectionFeatureDto extends createZodDto(setDetectionFeatureSchema) {}
