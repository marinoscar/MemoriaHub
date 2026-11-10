import { createZodDto } from 'nestjs-zod';
import { createWorkflowSchema } from '@marinoscar/memoriahub-contract/workflows';

export { createWorkflowSchema };

export class CreateWorkflowDto extends createZodDto(createWorkflowSchema) {}
