import { z } from 'zod';

export const initUploadSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().positive(),
  mimeType: z.string().min(1),
});

export type InitUploadDto = z.infer<typeof initUploadSchema>;

export interface InitUploadResponseDto {
  objectId: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  presignedUrls: Array<{
    partNumber: number;
    url: string;
  }>;
}
