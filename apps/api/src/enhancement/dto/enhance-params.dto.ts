import { createZodDto } from 'nestjs-zod';
import { enhanceParamsSchema, type EnhanceParams } from '@marinoscar/memoriahub-contract/enhancement';

export { enhanceParamsSchema };
export type { EnhanceParams };

export class EnhanceParamsDto extends createZodDto(enhanceParamsSchema) {}
