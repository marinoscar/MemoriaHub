import { createZodDto } from 'nestjs-zod';
import { upsertGeoCredentialSchema } from '@marinoscar/memoriahub-contract/location';

export { upsertGeoCredentialSchema };

export class UpsertGeoCredentialDto extends createZodDto(upsertGeoCredentialSchema) {}
