import { createZodDto } from 'nestjs-zod';
import { resolveDuplicateSchema } from '@marinoscar/memoriahub-contract/dedup';


export class ResolveDuplicateDto extends createZodDto(resolveDuplicateSchema) {}
