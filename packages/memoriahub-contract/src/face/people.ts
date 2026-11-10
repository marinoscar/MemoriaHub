import { z } from 'zod';


// ---------------------------------------------------------------------------
// ListPeopleQuery
// ---------------------------------------------------------------------------

/**
 * Wire schema `listPeopleQuerySchema`.
 *
 * @stability experimental
 */
export const listPeopleQuerySchema = z.object({
  circleId: z.string().uuid(),
  includeUnlabeled: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  hidden: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Scope to people appearing in a single album's media
  albumId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});


// ---------------------------------------------------------------------------
// CreatePersonDto
// ---------------------------------------------------------------------------

/**
 * Wire schema `createPersonSchema`.
 *
 * @stability experimental
 */
export const createPersonSchema = z.object({
  circleId: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  faceIds: z.array(z.string().uuid()).max(500).optional(),
});


// ---------------------------------------------------------------------------
// UpdatePersonDto
// ---------------------------------------------------------------------------

const profileCropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  })
  .nullable()
  .optional();

/**
 * Wire schema `updatePersonSchema`.
 *
 * @stability experimental
 */
export const updatePersonSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    coverFaceId: z.string().uuid().optional().nullable(),
    profileMediaItemId: z.string().uuid().optional().nullable(),
    profileCrop: profileCropSchema,
    favorite: z.boolean().optional(),
  })
  .refine(
    (v) => {
      // Both must be present (non-null) together, or both must be null/absent.
      const hasId = v.profileMediaItemId != null;
      const hasCrop = v.profileCrop != null;
      return hasId === hasCrop;
    },
    {
      message:
        'profileMediaItemId and profileCrop must both be provided or both be null',
      path: ['profileMediaItemId'],
    },
  )
  // .default({}) LAST, after .refine(), so a bodyless request parses as {} —
  // see issue #289 (app.module.ts). Note the refine is SKIPPED for that default
  // value; harmless here because {} would satisfy it anyway (both absent, so
  // hasId === hasCrop === false).
  .default({});


// ---------------------------------------------------------------------------
// AssignFacesDto
// ---------------------------------------------------------------------------

/**
 * Wire schema `assignFacesSchema`.
 *
 * @stability experimental
 */
export const assignFacesSchema = z.object({
  faceIds: z.array(z.string().uuid()).min(1).max(500),
});


// ---------------------------------------------------------------------------
// ClusterDto
// ---------------------------------------------------------------------------

/**
 * Wire schema `clusterSchema`.
 *
 * @stability experimental
 */
export const clusterSchema = z.object({
  circleId: z.string().uuid(),
});


// ---------------------------------------------------------------------------
// ListUnassignedFacesQueryDto
// ---------------------------------------------------------------------------

/**
 * Wire schema `listUnassignedFacesQuerySchema`.
 *
 * @stability experimental
 */
export const listUnassignedFacesQuerySchema = z.object({
  circleId: z.string().uuid(),
  archived: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});


// ---------------------------------------------------------------------------
// BulkPeopleDto  (shared shape: circleId + ids[])
// ---------------------------------------------------------------------------

/**
 * Wire schema `bulkPeopleSchema`.
 *
 * @stability experimental
 */
export const bulkPeopleSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
});


// ---------------------------------------------------------------------------
// BulkFacesDto  (identical { circleId, ids[] } shape; alias for face bulk ops
// so controller/service signatures read as face-scoped rather than people-scoped)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// PurgeArchivedFacesDto  (circle-wide purge of archived unassigned faces;
// same { circleId } shape as ClusterDto, aliased for a face-scoped signature)
// ---------------------------------------------------------------------------

/**
 * The parsed value of {@link listPeopleQuerySchema}.
 *
 * @stability experimental
 */
export type ListPeopleQuery = z.infer<typeof listPeopleQuerySchema>;

/**
 * The parsed value of {@link createPersonSchema}.
 *
 * @stability experimental
 */
export type CreatePerson = z.infer<typeof createPersonSchema>;

/**
 * The parsed value of {@link updatePersonSchema}.
 *
 * @stability experimental
 */
export type UpdatePerson = z.infer<typeof updatePersonSchema>;

/**
 * The parsed value of {@link assignFacesSchema}.
 *
 * @stability experimental
 */
export type AssignFaces = z.infer<typeof assignFacesSchema>;

/**
 * The parsed value of {@link clusterSchema}.
 *
 * @stability experimental
 */
export type Cluster = z.infer<typeof clusterSchema>;

/**
 * The parsed value of {@link listUnassignedFacesQuerySchema}.
 *
 * @stability experimental
 */
export type ListUnassignedFacesQuery = z.infer<typeof listUnassignedFacesQuerySchema>;

/**
 * The parsed value of {@link bulkPeopleSchema}.
 *
 * @stability experimental
 */
export type BulkPeople = z.infer<typeof bulkPeopleSchema>;
