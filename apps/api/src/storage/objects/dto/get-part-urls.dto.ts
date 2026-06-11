import { z } from 'zod';

export const getPartUrlsSchema = z.object({
  partNumbers: z
    .array(z.number().int().min(1))
    .min(1)
    .max(100, 'At most 100 part URLs can be requested per call'),
});

export type GetPartUrlsDto = z.infer<typeof getPartUrlsSchema>;

export interface GetPartUrlsResponseDto {
  presignedUrls: Array<{
    partNumber: number;
    url: string;
  }>;
}
