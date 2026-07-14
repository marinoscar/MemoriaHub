import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const testEmailSchema = z.object({
  recipient: z.string().email(),
});

export class TestEmailDto extends createZodDto(testEmailSchema) {}
