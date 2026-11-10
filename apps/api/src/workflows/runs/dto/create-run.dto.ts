import { createZodDto } from 'nestjs-zod';
import { createRunSchema } from '@marinoscar/memoriahub-contract/workflows';

export { createRunSchema };

export class CreateRunDto extends createZodDto(createRunSchema) {}
