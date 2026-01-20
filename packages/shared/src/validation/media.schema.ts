/**
 * Media Validation Schemas
 * Zod schemas for validating media-related inputs
 */

import { z } from 'zod';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
  ALLOWED_MEDIA_MIME_TYPES,
  DEFAULT_MAX_UPLOAD_SIZE,
} from '../types/media.types.js';

/**
 * Media asset status enum schema
 */
export const mediaAssetStatusSchema = z.enum([
  'UPLOADED',
  'METADATA_EXTRACTED',
  'DERIVATIVES_READY',
  'ENRICHED',
  'INDEXED',
  'READY',
  'ERROR',
]);

/**
 * Media type enum schema
 */
export const mediaTypeSchema = z.enum(['image', 'video']);

/**
 * File source enum schema
 */
export const fileSourceSchema = z.enum(['web', 'webdav', 'api']);

/**
 * Processing job type enum schema
 */
export const processingJobTypeSchema = z.enum([
  'extract_metadata',
  'generate_thumbnail',
  'generate_preview',
  'reverse_geocode',
  'detect_faces',
  'detect_objects',
  'index_search',
]);

/**
 * Processing job status enum schema
 */
export const processingJobStatusSchema = z.enum([
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * MIME type validation schema
 */
export const mimeTypeSchema = z
  .string()
  .refine(
    (type) => (ALLOWED_MEDIA_MIME_TYPES as readonly string[]).includes(type),
    { message: 'Unsupported file type' }
  );

/**
 * Initiate upload input schema
 * Note: libraryId is optional - if provided, asset will be added to library after upload
 */
export const initiateUploadSchema = z.object({
  libraryId: z.string().uuid('Invalid library ID').optional(),
  filename: z
    .string()
    .min(1, 'Filename is required')
    .max(512, 'Filename must be 512 characters or less')
    .refine(
      (name) => !name.includes('..') && !name.includes('/') && !name.includes('\\'),
      { message: 'Invalid filename' }
    ),
  mimeType: mimeTypeSchema,
  fileSize: z
    .number()
    .int()
    .positive('File size must be positive')
    .max(DEFAULT_MAX_UPLOAD_SIZE, `File size must be ${DEFAULT_MAX_UPLOAD_SIZE / 1024 / 1024}MB or less`),
});

/**
 * Complete upload input schema
 */
export const completeUploadSchema = z.object({
  assetId: z.string().uuid('Invalid asset ID'),
});

/**
 * Media asset ID param schema
 */
export const mediaAssetIdParamSchema = z.object({
  id: z.string().uuid('Invalid asset ID'),
});

/**
 * List media query schema (query parameters only)
 * Note: libraryId comes from URL path params, not query params
 */
export const listMediaQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  status: mediaAssetStatusSchema.optional(),
  mediaType: mediaTypeSchema.optional(),
  country: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  cameraMake: z.string().max(100).optional(),
  cameraModel: z.string().max(100).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  sortBy: z.enum(['capturedAt', 'createdAt', 'filename', 'fileSize']).optional().default('capturedAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

/**
 * List media by library params schema
 */
export const listMediaByLibraryParamsSchema = z.object({
  libraryId: z.string().uuid('Invalid library ID'),
});

/**
 * Bulk delete media input schema
 */
export const bulkDeleteMediaSchema = z.object({
  assetIds: z.array(z.string().uuid('Invalid asset ID')).min(1).max(100),
});

/**
 * Update media metadata input schema
 */
export const updateMediaMetadataSchema = z.object({
  capturedAtUtc: z.string().datetime().optional(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  locationName: z.string().max(255).optional().nullable(),
});

/**
 * Bulk update media metadata input schema
 */
export const bulkUpdateMediaMetadataSchema = z.object({
  updates: z.array(
    z.object({
      assetId: z.string().uuid('Invalid asset ID'),
      capturedAtUtc: z.string().datetime().optional(),
      latitude: z.number().min(-90).max(90).nullable().optional(),
      longitude: z.number().min(-180).max(180).nullable().optional(),
      country: z.string().max(100).nullable().optional(),
      state: z.string().max(100).nullable().optional(),
      city: z.string().max(100).nullable().optional(),
      locationName: z.string().max(255).nullable().optional(),
    })
  ).min(1, 'At least one update is required').max(100, 'Maximum 100 updates allowed'),
});

/**
 * Move media to library input schema
 */
export const moveMediaSchema = z.object({
  assetIds: z.array(z.string().uuid('Invalid asset ID')).min(1).max(100),
  targetLibraryId: z.string().uuid('Invalid library ID'),
});

// =============================================================================
// Media Sharing Schemas
// =============================================================================

/**
 * Share media with users schema
 */
export const shareMediaSchema = z.object({
  userIds: z.array(z.string().uuid('Invalid user ID')).min(1, 'At least one user ID is required'),
});

/**
 * Revoke share params schema
 */
export const revokeShareParamsSchema = z.object({
  id: z.string().uuid('Invalid asset ID'),
  userId: z.string().uuid('Invalid user ID'),
});

// Type exports
export type MediaAssetStatusInput = z.infer<typeof mediaAssetStatusSchema>;
export type MediaTypeInput = z.infer<typeof mediaTypeSchema>;
export type FileSourceInput = z.infer<typeof fileSourceSchema>;
export type ProcessingJobTypeInput = z.infer<typeof processingJobTypeSchema>;
export type ProcessingJobStatusInput = z.infer<typeof processingJobStatusSchema>;
export type InitiateUploadInput = z.infer<typeof initiateUploadSchema>;
export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;
export type MediaAssetIdParamInput = z.infer<typeof mediaAssetIdParamSchema>;
export type ListMediaQueryInput = z.infer<typeof listMediaQuerySchema>;
export type ListMediaByLibraryParamsInput = z.infer<typeof listMediaByLibraryParamsSchema>;
export type BulkDeleteMediaInput = z.infer<typeof bulkDeleteMediaSchema>;
export type UpdateMediaMetadataInput = z.infer<typeof updateMediaMetadataSchema>;
export type BulkUpdateMediaMetadataInput = z.infer<typeof bulkUpdateMediaMetadataSchema>;
export type MoveMediaInput = z.infer<typeof moveMediaSchema>;
export type ShareMediaInput = z.infer<typeof shareMediaSchema>;
export type RevokeShareParamsInput = z.infer<typeof revokeShareParamsSchema>;

/**
 * Helper to determine media type from MIME type
 */
export function getMediaTypeFromMimeType(mimeType: string): 'image' | 'video' | null {
  if ((ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return 'image';
  }
  if ((ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return 'video';
  }
  return null;
}

/**
 * Helper to check if MIME type is allowed
 */
export function isAllowedMimeType(mimeType: string): boolean {
  return (ALLOWED_MEDIA_MIME_TYPES as readonly string[]).includes(mimeType);
}
