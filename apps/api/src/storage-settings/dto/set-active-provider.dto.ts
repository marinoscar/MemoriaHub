import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const setActiveStorageProviderSchema = z.object({
  provider: z.string().min(1),
});
export class SetActiveStorageProviderDto extends createZodDto(setActiveStorageProviderSchema) {}
