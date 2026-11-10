import { createZodDto } from 'nestjs-zod';
import { listAdminWorkflowsQuerySchema } from '@marinoscar/memoriahub-contract/workflows';


export class ListAdminWorkflowsQueryDto extends createZodDto(listAdminWorkflowsQuerySchema) {}
