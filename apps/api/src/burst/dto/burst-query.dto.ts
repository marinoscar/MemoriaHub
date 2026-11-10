import { createZodDto } from 'nestjs-zod';
import { burstQuerySchema } from '@marinoscar/memoriahub-contract/burst';

export { burstQuerySchema };

export class BurstQueryDto extends createZodDto(burstQuerySchema) {}
