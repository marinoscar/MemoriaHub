/**
 * Library Validation Schemas
 * Zod schemas for validating library-related inputs
 */

import { z } from 'zod';

/**
 * Library visibility enum schema
 */
export const libraryVisibilitySchema = z.enum(['private', 'shared', 'public']);

/**
 * Library member role enum schema
 */
export const libraryMemberRoleSchema = z.enum(['viewer', 'contributor', 'admin']);

/**
 * Create library input schema
 */
export const createLibrarySchema = z.object({
  name: z
    .string()
    .min(1, 'Library name is required')
    .max(255, 'Library name must be 255 characters or less')
    .trim(),
  description: z
    .string()
    .max(1000, 'Description must be 1000 characters or less')
    .trim()
    .optional()
    .nullable(),
  visibility: libraryVisibilitySchema.optional().default('private'),
});

/**
 * Update library input schema
 */
export const updateLibrarySchema = z.object({
  name: z
    .string()
    .min(1, 'Library name is required')
    .max(255, 'Library name must be 255 characters or less')
    .trim()
    .optional(),
  description: z
    .string()
    .max(1000, 'Description must be 1000 characters or less')
    .trim()
    .optional()
    .nullable(),
  visibility: libraryVisibilitySchema.optional(),
  coverAssetId: z.string().uuid('Invalid asset ID').optional().nullable(),
});

/**
 * Add library member input schema
 */
export const addLibraryMemberSchema = z.object({
  userId: z.string().uuid('Invalid user ID'),
  role: libraryMemberRoleSchema.optional().default('viewer'),
});

/**
 * Update library member input schema
 */
export const updateLibraryMemberSchema = z.object({
  role: libraryMemberRoleSchema,
});

/**
 * Library ID param schema
 */
export const libraryIdParamSchema = z.object({
  id: z.string().uuid('Invalid library ID'),
});

/**
 * Library member params schema
 */
export const libraryMemberParamsSchema = z.object({
  id: z.string().uuid('Invalid library ID'),
  userId: z.string().uuid('Invalid user ID'),
});

/**
 * List libraries query schema
 */
export const listLibrariesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  visibility: libraryVisibilitySchema.optional(),
  includeShared: z
    .string()
    .transform((val) => val === 'true')
    .optional()
    .default('true'),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

// Type exports
export type LibraryVisibilityInput = z.infer<typeof libraryVisibilitySchema>;
export type LibraryMemberRoleInput = z.infer<typeof libraryMemberRoleSchema>;
export type CreateLibraryInput = z.infer<typeof createLibrarySchema>;
export type UpdateLibraryInput = z.infer<typeof updateLibrarySchema>;
export type AddLibraryMemberInput = z.infer<typeof addLibraryMemberSchema>;
export type UpdateLibraryMemberInput = z.infer<typeof updateLibraryMemberSchema>;
export type LibraryIdParamInput = z.infer<typeof libraryIdParamSchema>;
export type LibraryMemberParamsInput = z.infer<typeof libraryMemberParamsSchema>;
export type ListLibrariesQueryInput = z.infer<typeof listLibrariesQuerySchema>;
