import { createZodDto } from 'nestjs-zod';
import { resolveBurstSchema } from '@marinoscar/memoriahub-contract/burst';


export class ResolveBurstDto extends createZodDto(resolveBurstSchema) {}
