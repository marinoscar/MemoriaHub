import { createZodDto } from 'nestjs-zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  GROUPED_FILTERS,
  LOCATION_GROUP_LEVELS,
  ListLocationGroupsSchema,
  CreateLocationGroupSchema,
  UpdateLocationGroupSchema,
  LocationGroupMembersSchema,
  ListLocationValuesSchema,
  MergeLocationGroupsSchema,
  ListLocationGroupSuggestionsSchema,
  RebuildLocationGroupsSchema,
  type LocationGroupLevelValue,
} from '@marinoscar/memoriahub-contract/location';

// The schemas and the level vocabulary live in `@marinoscar/memoriahub-contract/location`;
// the classes below add the Swagger metadata. Re-exported so callers keep this import path.
export { GROUPED_FILTERS, LOCATION_GROUP_LEVELS, ListLocationGroupsSchema, CreateLocationGroupSchema, UpdateLocationGroupSchema, LocationGroupMembersSchema, ListLocationValuesSchema, MergeLocationGroupsSchema, ListLocationGroupSuggestionsSchema, RebuildLocationGroupsSchema };
export type { LocationGroupLevelValue };

/**
 * Query of `GET /api/location-groups`.
 *
 * @stability experimental
 */
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

/**
 * Body of `POST /api/location-groups`.
 *
 * @stability experimental
 */
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

/**
 * Body of `PATCH /api/location-groups/:id`.
 *
 * @stability experimental
 */
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

/**
 * Body of the add and remove member endpoints.
 *
 * @stability experimental
 */
export class LocationGroupMembersDto extends createZodDto(LocationGroupMembersSchema) {
  @ApiProperty({ type: [String] })
  declare values: string[];
}

/**
 * Query of `GET /api/location-groups/values`.
 *
 * @stability experimental
 */
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

/**
 * Body of `POST /api/location-groups/merge`.
 *
 * @stability experimental
 */
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

/**
 * Query of `GET /api/location-groups/suggestions`.
 *
 * @stability experimental
 */
export class ListLocationGroupSuggestionsDto extends createZodDto(
  ListLocationGroupSuggestionsSchema,
) {
  @ApiProperty({ enum: LOCATION_GROUP_LEVELS })
  declare level: LocationGroupLevelValue;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  declare limit: number;
}

/**
 * Body of `POST /api/admin/location-groups/rebuild`.
 *
 * @stability experimental
 */
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
