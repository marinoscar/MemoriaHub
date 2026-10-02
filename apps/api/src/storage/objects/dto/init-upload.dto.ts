import { z } from 'zod';

export const initUploadSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().positive(),
  mimeType: z.string().min(1),
});

export type InitUploadDto = z.infer<typeof initUploadSchema>;

/**
 * How a client must authenticate the PUT of each part URL (issue #506).
 *
 * - `none`: the URL is a presigned S3/R2 URL. Send NO Authorization header —
 *   S3 rejects a request carrying both a signature and a bearer token, and the
 *   token must never leave for a third-party host.
 * - `bearer`: the URL is this API's own
 *   `PUT /api/storage/objects/:id/upload/parts/:n` route (the `local` storage
 *   provider has no URL a device can reach). Send the same `Authorization:
 *   Bearer` credential (JWT or PAT) used for every other API call.
 */
export type PartUploadAuth = 'none' | 'bearer';

export interface InitUploadResponseDto {
  objectId: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  presignedUrls: Array<{
    partNumber: number;
    url: string;
  }>;
  /** How to authenticate the PUT to each URL in `presignedUrls`. */
  partUploadAuth: PartUploadAuth;
}
