import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const schema = z.object({ keepIds: z.array(z.string().uuid()).min(1) });

export class ResolveBurstDto extends createZodDto(schema) {}
