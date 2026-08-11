import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTOs for the Location Grouping management API (issue #374).
 *
 * Level values mirror the `LocationGroupLevel` Prisma enum exactly. They are
 * re-declared as a plain tuple rather than imported from `@prisma/client`
 * because `z.enum` needs a literal tuple and `@nestjs/swagger` needs a plain
 * array for its `enum:` metadata.
 */
export const LOCATION_GROUP_LEVELS = ['country', 'region', 'locality'] as const;
export type LocationGroupLevelValue = (typeof LOCATION_GROUP_LEVELS)[number];

/** `grouped` filter for `GET /api/location-groups/values`. */
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

export class ListLocationGroupsDto extends createZodDto(ListLocationGroupsSchema) {
  @ApiPropertyOptional({ enum: LOCATION_GROUP_LEVELS })
  declare level?: LocationGroupLevelValue;

  @ApiPropertyOptional({ description: 'Filter by enabled flag' })
  declare enabled?: boolean;

  @ApiPropertyOptional({ description: 'Case-insensitive substring of the canonical name' })
  declare q?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  declare page: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  declare pageSize: number;
}

// ---------------------------------------------------------------------------
// POST /api/location-groups
// ---------------------------------------------------------------------------

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

export class CreateLocationGroupDto extends createZodDto(CreateLocationGroupSchema) {
  @ApiProperty({ enum: LOCATION_GROUP_LEVELS })
  declare level: LocationGroupLevelValue;

  @ApiProperty({ description: 'Display name every member value collapses into' })
  declare canonicalName: string;

  @ApiPropertyOptional({ description: "ISO country scope; '' means unscoped", default: '' })
  declare countryCode: string;

  @ApiPropertyOptional({ type: [String], description: 'Raw geocoder values to claim' })
  declare memberValues: string[];

  @ApiPropertyOptional({ description: 'Cover photo; must already resolve to this group' })
  declare coverMediaItemId?: string | null;

  @ApiPropertyOptional({ description: 'Geographic centre; requires radiusKm' })
  declare center?: { lat: number; lng: number } | null;

  @ApiPropertyOptional({ description: 'Capture radius in km; requires center' })
  declare radiusKm?: number | null;

  @ApiPropertyOptional({ default: true })
  declare enabled: boolean;

  @ApiPropertyOptional()
  declare notes?: string | null;
}

// ---------------------------------------------------------------------------
// PATCH /api/location-groups/:id
// ---------------------------------------------------------------------------

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

export class UpdateLocationGroupDto extends createZodDto(UpdateLocationGroupSchema) {
  @ApiPropertyOptional()
  declare canonicalName?: string;

  @ApiPropertyOptional()
  declare enabled?: boolean;

  @ApiPropertyOptional()
  declare coverMediaItemId?: string | null;

  @ApiPropertyOptional()
  declare center?: { lat: number; lng: number } | null;

  @ApiPropertyOptional()
  declare radiusKm?: number | null;

  @ApiPropertyOptional()
  declare notes?: string | null;
}

// ---------------------------------------------------------------------------
// POST / DELETE /api/location-groups/:id/members
// ---------------------------------------------------------------------------

export const LocationGroupMembersSchema = z
  .object({
    values: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
  })
  .strict();

export class LocationGroupMembersDto extends createZodDto(LocationGroupMembersSchema) {
  @ApiProperty({ type: [String] })
  declare values: string[];
}

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
 */
export const ListLocationValuesSchema = z.object({
  level: z.enum(LOCATION_GROUP_LEVELS),
  q: z.string().trim().min(1).max(200).optional(),
  grouped: z.enum(GROUPED_FILTERS).default('all'),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
});

export class ListLocationValuesDto extends createZodDto(ListLocationValuesSchema) {
  @ApiProperty({ enum: LOCATION_GROUP_LEVELS })
  declare level: LocationGroupLevelValue;

  @ApiPropertyOptional({ description: 'Case-insensitive substring of the raw value' })
  declare q?: string;

  @ApiPropertyOptional({ enum: GROUPED_FILTERS, default: 'all' })
  declare grouped: (typeof GROUPED_FILTERS)[number];

  @ApiPropertyOptional({
    default: 500,
    minimum: 1,
    maximum: 2000,
    description:
      'Legacy cap, used ONLY when neither page nor pageSize is supplied. Ignored in paginated mode.',
  })
  declare limit: number;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'One-based page. Supplying page or pageSize selects paginated mode.',
  })
  declare page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, description: 'Page size (default 50).' })
  declare pageSize?: number;
}

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

export class MergeLocationGroupsDto extends createZodDto(MergeLocationGroupsSchema) {
  @ApiProperty({ enum: LOCATION_GROUP_LEVELS })
  declare level: LocationGroupLevelValue;

  @ApiPropertyOptional({
    description:
      "ISO country scope. Omitted means unscoped ('') when creating, or the target group's own scope when merging into one.",
  })
  declare countryCode?: string;

  @ApiProperty({ type: [String], description: 'Raw geocoder values to fold into the group' })
  declare values: string[];

  @ApiPropertyOptional({
    description: 'Merge into this existing group (never renames it). Mutually exclusive with canonicalName.',
  })
  declare targetGroupId?: string;

  @ApiPropertyOptional({
    description: 'Create a new group with this canonical name. Mutually exclusive with targetGroupId.',
  })
  declare canonicalName?: string;
}

// ---------------------------------------------------------------------------
// GET /api/location-groups/suggestions
// ---------------------------------------------------------------------------

export const ListLocationGroupSuggestionsSchema = z.object({
  level: z.enum(LOCATION_GROUP_LEVELS),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export class ListLocationGroupSuggestionsDto extends createZodDto(
  ListLocationGroupSuggestionsSchema,
) {
  @ApiProperty({ enum: LOCATION_GROUP_LEVELS })
  declare level: LocationGroupLevelValue;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  declare limit: number;
}

// ---------------------------------------------------------------------------
// POST /api/admin/location-groups/rebuild
// ---------------------------------------------------------------------------

/**
 * `.prefault({})` so a bodyless POST parses exactly like `{}` — the issue #289
 * precedent shared with `admin-metadata.controller.ts` /
 * `geocode-admin.controller.ts`.
 */
export const RebuildLocationGroupsSchema = z
  .object({
    circleId: z.string().uuid().optional(),
    groupIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  })
  .prefault({});

export class RebuildLocationGroupsDto extends createZodDto(RebuildLocationGroupsSchema) {
  @ApiPropertyOptional({ description: 'Restrict the rebuild to one circle' })
  declare circleId?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Restrict the alias/radius passes to specific groups. The RESET pass always runs over the full scope, so a partial list leaves every OTHER group reverted to raw names until the next full rebuild.',
  })
  declare groupIds?: string[];
}
