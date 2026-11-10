import { z } from 'zod';


/**
 * DTOs for the Location Grouping management API (issue #374).
 *
 * Level values mirror the `LocationGroupLevel` Prisma enum exactly. They are
 * re-declared as a plain tuple rather than imported from `@prisma/client`
 * because `z.enum` needs a literal tuple and `@nestjs/swagger` needs a plain
 * array for its `enum:` metadata.
 *
 * @stability experimental
 */
export const LOCATION_GROUP_LEVELS = ['country', 'region', 'locality'] as const;
/**
 * Wire type `LocationGroupLevelValue`.
 *
 * @stability experimental
 */
export type LocationGroupLevelValue = (typeof LOCATION_GROUP_LEVELS)[number];

/**
 * `grouped` filter for `GET /api/location-groups/values`.
 *
 * @stability experimental
 */
export const GROUPED_FILTERS = ['all', 'ungrouped', 'grouped'] as const;

/**
 * A group's geographic centre. Deliberately a nested object rather than two
 * sibling scalars, so "supply both or neither" is expressible as one optional
 * field instead of a cross-field refine — the `radiusKm` pairing rule then has
 * exactly ONE place it can fail (the service), not two.
 */
const centerSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// ---------------------------------------------------------------------------
// GET /api/location-groups
// ---------------------------------------------------------------------------

/**
 * Wire schema `ListLocationGroupsSchema`.
 *
 * @stability experimental
 */
export const ListLocationGroupsSchema = z
  .object({
    level: z.enum(LOCATION_GROUP_LEVELS).optional(),
    // Query strings arrive as strings, so `enabled` is coerced from the two
    // literals a client can actually send rather than z.coerce.boolean(),
    // which treats the string "false" as true.
    enabled: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
      .optional(),
    q: z.string().trim().min(1).max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .default({ page: 1, pageSize: 50 });



// ---------------------------------------------------------------------------
// POST /api/location-groups
// ---------------------------------------------------------------------------

/**
 * Wire schema `CreateLocationGroupSchema`.
 *
 * @stability experimental
 */
export const CreateLocationGroupSchema = z
  .object({
    level: z.enum(LOCATION_GROUP_LEVELS),
    canonicalName: z.string().trim().min(1).max(200),
    // '' is the deliberate UNSCOPED sentinel, never null — Postgres unique
    // indexes treat every NULL as distinct, which would silently permit two
    // same-named groups to coexist under the (level, countryCode,
    // normalizedName) unique index. Same pitfall as Memory.subjectKey.
    countryCode: z.string().trim().max(8).default(''),
    memberValues: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
    coverMediaItemId: z.string().uuid().nullable().optional(),
    center: centerSchema.nullable().optional(),
    radiusKm: z.number().positive().max(200).nullable().optional(),
    enabled: z.boolean().default(true),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();



// ---------------------------------------------------------------------------
// PATCH /api/location-groups/:id
// ---------------------------------------------------------------------------

/**
 * Wire schema `UpdateLocationGroupSchema`.
 *
 * @stability experimental
 */
export const UpdateLocationGroupSchema = z
  .object({
    canonicalName: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    coverMediaItemId: z.string().uuid().nullable().optional(),
    center: centerSchema.nullable().optional(),
    radiusKm: z.number().positive().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();



// ---------------------------------------------------------------------------
// POST / DELETE /api/location-groups/:id/members
// ---------------------------------------------------------------------------

/**
 * Wire schema `LocationGroupMembersSchema`.
 *
 * @stability experimental
 */
export const LocationGroupMembersSchema = z
  .object({
    values: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
  })
  .strict();



// ---------------------------------------------------------------------------
// GET /api/location-groups/values
// ---------------------------------------------------------------------------

/**
 * NO top-level `.default({})` here (or on the suggestions schema below): `level`
 * is REQUIRED, and a default would silently invent one for a caller who forgot
 * it, answering with a different tier's data instead of a 400.
 *
 * `page`/`pageSize` are deliberately `.optional()` with NO default (unlike
 * `ListLocationGroupsSchema`, where both default): their PRESENCE is what
 * selects paginated mode, so a default would silently switch every legacy
 * `limit`-only caller over. See `LocationGroupsService.listValues` for the
 * precedence rule.
 *
 * @stability experimental
 */
export const ListLocationValuesSchema = z.object({
  level: z.enum(LOCATION_GROUP_LEVELS),
  q: z.string().trim().min(1).max(200).optional(),
  grouped: z.enum(GROUPED_FILTERS).default('all'),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
});



// ---------------------------------------------------------------------------
// POST /api/location-groups/merge
// ---------------------------------------------------------------------------

/**
 * `POST /api/location-groups/merge` (issue #407) — the select-many-and-merge
 * flow behind the Location Groups admin page's bulk selection.
 *
 * `targetGroupId` XOR `canonicalName` is enforced in the SERVICE, not with a
 * zod `.refine`, so the rule has exactly ONE place it can fail — the same
 * reasoning that keeps the `center`/`radiusKm` pairing rule out of this file.
 *
 * @stability experimental
 */
export const MergeLocationGroupsSchema = z
  .object({
    level: z.enum(LOCATION_GROUP_LEVELS),
    // Optional with NO default (unlike CreateLocationGroupSchema): an omitted
    // countryCode means "inherit the target group's scope" on the merge-into
    // path, which a '' default would turn into a scope MISMATCH 400.
    countryCode: z.string().trim().max(8).optional(),
    values: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
    targetGroupId: z.string().uuid().optional(),
    canonicalName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();



// ---------------------------------------------------------------------------
// GET /api/location-groups/suggestions
// ---------------------------------------------------------------------------

/**
 * Wire schema `ListLocationGroupSuggestionsSchema`.
 *
 * @stability experimental
 */
export const ListLocationGroupSuggestionsSchema = z.object({
  level: z.enum(LOCATION_GROUP_LEVELS),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});



// ---------------------------------------------------------------------------
// POST /api/admin/location-groups/rebuild
// ---------------------------------------------------------------------------

/**
 * `.prefault({})` so a bodyless POST parses exactly like `{}` — the issue #289
 * precedent shared with `admin-metadata.controller.ts` /
 * `geocode-admin.controller.ts`.
 *
 * @stability experimental
 */
export const RebuildLocationGroupsSchema = z
  .object({
    circleId: z.string().uuid().optional(),
    groupIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  })
  .prefault({});

/**
 * The parsed value of {@link ListLocationGroupsSchema}.
 *
 * @stability experimental
 */
export type ListLocationGroups = z.infer<typeof ListLocationGroupsSchema>;

/**
 * The parsed value of {@link CreateLocationGroupSchema}.
 *
 * @stability experimental
 */
export type CreateLocationGroup = z.infer<typeof CreateLocationGroupSchema>;

/**
 * The parsed value of {@link UpdateLocationGroupSchema}.
 *
 * @stability experimental
 */
export type UpdateLocationGroup = z.infer<typeof UpdateLocationGroupSchema>;

/**
 * The parsed value of {@link LocationGroupMembersSchema}.
 *
 * @stability experimental
 */
export type LocationGroupMembers = z.infer<typeof LocationGroupMembersSchema>;

/**
 * The parsed value of {@link ListLocationValuesSchema}.
 *
 * @stability experimental
 */
export type ListLocationValues = z.infer<typeof ListLocationValuesSchema>;

/**
 * The parsed value of {@link MergeLocationGroupsSchema}.
 *
 * @stability experimental
 */
export type MergeLocationGroups = z.infer<typeof MergeLocationGroupsSchema>;

/**
 * The parsed value of {@link ListLocationGroupSuggestionsSchema}.
 *
 * @stability experimental
 */
export type ListLocationGroupSuggestions = z.infer<typeof ListLocationGroupSuggestionsSchema>;

/**
 * The parsed value of {@link RebuildLocationGroupsSchema}.
 *
 * @stability experimental
 */
export type RebuildLocationGroups = z.infer<typeof RebuildLocationGroupsSchema>;
