import { createZodDto } from 'nestjs-zod';
import { updateWorkflowSchema } from '@marinoscar/memoriahub-contract/workflows';

export { updateWorkflowSchema };

export class UpdateWorkflowDto extends createZodDto(updateWorkflowSchema) {}
