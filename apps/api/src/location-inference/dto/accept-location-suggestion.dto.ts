import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const schema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  // .default({}) so a bodyless POST (accept unmodified) parses as {} — see
  // issue #289 (app.module.ts).
}).default({});

export class AcceptLocationSuggestionDto extends createZodDto(schema) {}
