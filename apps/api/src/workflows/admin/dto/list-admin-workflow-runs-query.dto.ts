import { createZodDto } from 'nestjs-zod';
import { listAdminWorkflowRunsQuerySchema } from '@marinoscar/memoriahub-contract/workflows';


export class ListAdminWorkflowRunsQueryDto extends createZodDto(listAdminWorkflowRunsQuerySchema) {}
