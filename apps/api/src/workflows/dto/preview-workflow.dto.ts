import { createZodDto } from 'nestjs-zod';
import { previewWorkflowSchema } from '@marinoscar/memoriahub-contract/workflows';

export { previewWorkflowSchema };

export class PreviewWorkflowDto extends createZodDto(previewWorkflowSchema) {}
