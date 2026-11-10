import { createZodDto } from 'nestjs-zod';
import { listWorkflowsQuerySchema } from '@marinoscar/memoriahub-contract/workflows';

export { listWorkflowsQuerySchema };

export class ListWorkflowsQueryDto extends createZodDto(listWorkflowsQuerySchema) {}
