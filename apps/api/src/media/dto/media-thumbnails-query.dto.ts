import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const mediaThumbnailsQuerySchema = z.object({
  circleId: z.string().uuid(),
  // Comma-separated list of media item UUIDs (1–200), transformed to string[].
  ids: z
    .string()
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(z.string().uuid()).min(1).max(200)),
});

export class MediaThumbnailsQueryDto extends createZodDto(
  mediaThumbnailsQuerySchema,
) {}
