import { z } from 'zod';
import { WorkflowActionPermission } from '../registry/field-descriptor.interface';

/**
 * Media Workflow Automation — per-action parameter schemas (issue #140).
 *
 * Every registered Media-Item action has a Zod schema here validating its
 * `params` object. No-param actions use `z.object({}).strict()` so unexpected
 * keys are rejected. These are pure (no I/O) and shared by the registry
 * catalog (`MEDIA_ITEM_ACTIONS`) and the run-create path, which validates a
 * definition's action `params` against the matching schema before persisting.
 */

/** Shared: a non-empty list of tag names (case-insensitive at apply time). */
const tagNames = z.array(z.string().min(1).max(128)).min(1);

/** Shared: the archive-vs-trash resolution action for review-queue groups. */
const resolveAction = z.enum(['archive', 'trash']);

// ---------------------------------------------------------------------------
// No-param actions
// ---------------------------------------------------------------------------

export const emptyParamsSchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Item-level actions
// ---------------------------------------------------------------------------

/** Add to an existing album (`albumId`) XOR create a new one (`createAlbumNamed`). */
export const addToAlbumParamsSchema = z
  .object({
    albumId: z.string().uuid().optional(),
    createAlbumNamed: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine(
    (v) => (v.albumId ? 1 : 0) + (v.createAlbumNamed ? 1 : 0) === 1,
    { message: 'Provide exactly one of albumId or createAlbumNamed' },
  );

export const removeFromAlbumParamsSchema = z
  .object({ albumId: z.string().uuid() })
  .strict();

export const addTagsParamsSchema = z.object({ names: tagNames }).strict();

export const removeTagsParamsSchema = z
  .object({
    names: tagNames,
    // Which tag sources are eligible for removal. Defaults to AI + system so a
    // cleanup workflow never strips a user's manually-applied tags.
    sources: z
      .array(z.enum(['manual', 'ai', 'system']))
      .min(1)
      .optional()
      .default(['ai', 'system']),
  })
  .strict();

export const setFavoriteParamsSchema = z.object({ value: z.boolean() }).strict();

/**
 * Set / shift / clear the capture date.
 *   - mode 'set'   → requires `value` (ISO-8601), forbids `shiftMinutes`
 *   - mode 'shift' → requires `shiftMinutes` (int), forbids `value`
 *   - mode 'clear' → forbids both
 */
export const setCapturedAtParamsSchema = z
  .object({
    mode: z.enum(['set', 'shift', 'clear']),
    value: z.string().datetime().optional(),
    shiftMinutes: z.number().int().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === 'set') {
      if (v.value === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value is required when mode is 'set'", path: ['value'] });
      }
      if (v.shiftMinutes !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "shiftMinutes is not allowed when mode is 'set'", path: ['shiftMinutes'] });
      }
    } else if (v.mode === 'shift') {
      if (v.shiftMinutes === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "shiftMinutes is required when mode is 'shift'", path: ['shiftMinutes'] });
      }
      if (v.value !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value is not allowed when mode is 'shift'", path: ['value'] });
      }
    } else {
      // mode === 'clear'
      if (v.value !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value is not allowed when mode is 'clear'", path: ['value'] });
      }
      if (v.shiftMinutes !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "shiftMinutes is not allowed when mode is 'clear'", path: ['shiftMinutes'] });
      }
    }
  });

export const assignPersonParamsSchema = z.object({ personId: z.string().uuid() }).strict();

export const removePersonParamsSchema = z.object({ personId: z.string().uuid() }).strict();

export const setLocationParamsSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .strict();

export const moveToCircleParamsSchema = z
  .object({ targetCircleId: z.string().uuid() })
  .strict();

export const rerunEnrichmentParamsSchema = z
  .object({
    kinds: z
      .array(z.enum(['tagging', 'faces', 'metadata', 'thumbnail', 'duplicates']))
      .min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Review-queue actions
// ---------------------------------------------------------------------------

export const resolveBurstGroupParamsSchema = z.object({ action: resolveAction }).strict();

export const resolveDuplicateGroupParamsSchema = z.object({ action: resolveAction }).strict();

// ---------------------------------------------------------------------------
// Permission presets (see WorkflowActionPermission docblock)
// ---------------------------------------------------------------------------

/** Base: circle collaborator + system media:write. */
export const BASE_ACTION_PERMISSION: WorkflowActionPermission = {
  circleRole: 'collaborator',
  systemPerms: ['media:write'],
};

/** hard_delete: base + media:delete, gated on workflows.allowHardDelete. */
export const HARD_DELETE_PERMISSION: WorkflowActionPermission = {
  circleRole: 'collaborator',
  systemPerms: ['media:write', 'media:delete'],
  gates: ['workflows.allowHardDelete'],
};

/** Burst/duplicate resolve: base, plus media:delete only for the trash variant. */
export const RESOLVE_GROUP_PERMISSION: WorkflowActionPermission = {
  circleRole: 'collaborator',
  systemPerms: ['media:write'],
  extraPermForTrashVariant: 'media:delete',
};

/** move_to_circle: collaborator + media:write on BOTH source and target circle. */
export const MOVE_TO_CIRCLE_PERMISSION: WorkflowActionPermission = {
  circleRole: 'collaborator',
  systemPerms: ['media:write'],
  bothCircles: true,
};
