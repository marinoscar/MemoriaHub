import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const schema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export class AcceptLocationSuggestionDto extends createZodDto(schema) {}
