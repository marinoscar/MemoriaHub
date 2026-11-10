import { createZodDto } from 'nestjs-zod';
import { approveRunSchema } from '@marinoscar/memoriahub-contract/workflows';

export { approveRunSchema };

export class ApproveRunDto extends createZodDto(approveRunSchema) {}
