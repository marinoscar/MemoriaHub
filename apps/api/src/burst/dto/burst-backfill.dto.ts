import { createZodDto } from 'nestjs-zod';
import { burstBackfillSchema } from '@marinoscar/memoriahub-contract/burst';


export class BurstBackfillDto extends createZodDto(burstBackfillSchema) {}
