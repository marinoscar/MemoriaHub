import { createZodDto } from 'nestjs-zod';
import { applyEnhancementSchema } from '@marinoscar/memoriahub-contract/enhancement';

export { applyEnhancementSchema };

export class ApplyEnhancementDto extends createZodDto(applyEnhancementSchema) {}
