import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// ListPeopleQuery
// ---------------------------------------------------------------------------

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
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export class ListPeopleQueryDto extends createZodDto(listPeopleQuerySchema) {}

// ---------------------------------------------------------------------------
// CreatePersonDto
// ---------------------------------------------------------------------------

export const createPersonSchema = z.object({
  circleId: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  faceIds: z.array(z.string().uuid()).max(500).optional(),
});

export class CreatePersonDto extends createZodDto(createPersonSchema) {}

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
  );

export class UpdatePersonDto extends createZodDto(updatePersonSchema) {}

// ---------------------------------------------------------------------------
// AssignFacesDto
// ---------------------------------------------------------------------------

export const assignFacesSchema = z.object({
  faceIds: z.array(z.string().uuid()).min(1).max(500),
});

export class AssignFacesDto extends createZodDto(assignFacesSchema) {}

// ---------------------------------------------------------------------------
// ClusterDto
// ---------------------------------------------------------------------------

export const clusterSchema = z.object({
  circleId: z.string().uuid(),
});

export class ClusterDto extends createZodDto(clusterSchema) {}

// ---------------------------------------------------------------------------
// ListUnassignedFacesQueryDto
// ---------------------------------------------------------------------------

export const listUnassignedFacesQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export class ListUnassignedFacesQueryDto extends createZodDto(listUnassignedFacesQuerySchema) {}

// ---------------------------------------------------------------------------
// BulkPeopleDto  (shared shape: circleId + ids[])
// ---------------------------------------------------------------------------

export const bulkPeopleSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
});

export class BulkPeopleDto extends createZodDto(bulkPeopleSchema) {}
