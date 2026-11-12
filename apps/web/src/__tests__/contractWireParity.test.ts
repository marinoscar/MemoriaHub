// =============================================================================
// Wire types the web client shares with @marinoscar/memoriahub-contract (RETRO-J2, #598)
// =============================================================================
//
// A type-level proof, checked by `tsc` (npm run typecheck), that the request types the service
// clients export ARE the contract's, not a hand-kept copy that can drift:
//
//   * `Equal<A, B>` is true only for mutually identical types (not merely assignable).
//   * Each `true` below is a type that used to be declared by hand in `services/*.ts` and is now
//     an alias of the contract schema's INPUT side (`z.input`: what a client may send, defaults
//     optional), so the assertion fails to compile if either side is edited alone.
//   * Each `false` is a hand-written type that MUST stay, with the reason: a query string reaches the
//     API as text (`z.coerce.number()`), so the schema's input side is `unknown` where the client
//     sends `number`; asserting `false` pins that difference so it is noticed if the contract changes.
//
// The test body only exists so Vitest collects the file; the value is the compile-time check.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  EnhancementStatus,
  EnhancementStatusAlias,
  listEnhancementBatchesQuerySchema,
  listEnhancementsQuerySchema,
  ListEnhancementsQuery,
} from '@marinoscar/memoriahub-contract/enhancement';
import type {
  CreateLocationGroupSchema,
  MergeLocationGroupsSchema,
  UpdateLocationGroupSchema,
} from '@marinoscar/memoriahub-contract/location';
import type { UpdateConfigInput } from '@marinoscar/memoriahub-contract/media-sync';

import type {
  EnhancementSortBy,
  EnhancementSortOrder,
  EnhancementStatusFilter,
  ListEnhancementBatchesParams,
  ListEnhancementsParams,
} from '@marinoscar/memoriahub-web/enhancement/headless';
import type {
  CreateLocationGroupBody,
  MergeLocationGroupsBody,
  UpdateLocationGroupBody,
} from '@marinoscar/memoriahub-web/location/headless';
import type { MediaSyncConfigPatch } from '@marinoscar/memoriahub-web/media-sync/headless';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>() => undefined;
const assertNotEqual = <_T extends false>() => undefined;

// Shared with the contract.
assertType<Equal<CreateLocationGroupBody, z.input<typeof CreateLocationGroupSchema>>>();
assertType<Equal<UpdateLocationGroupBody, z.input<typeof UpdateLocationGroupSchema>>>();
assertType<Equal<MergeLocationGroupsBody, z.input<typeof MergeLocationGroupsSchema>>>();
assertType<Equal<MediaSyncConfigPatch, Omit<UpdateConfigInput, 'inventory'>>>();
assertType<Equal<EnhancementStatusFilter, EnhancementStatus | EnhancementStatusAlias>>();
assertType<Equal<EnhancementSortBy, NonNullable<ListEnhancementsQuery['sortBy']>>>();
assertType<Equal<EnhancementSortOrder, NonNullable<ListEnhancementsQuery['sortOrder']>>>();

// Must stay hand-written: the schema's input side is `unknown` for the coerced numbers.
assertNotEqual<Equal<ListEnhancementsParams, z.input<typeof listEnhancementsQuerySchema>>>();
assertNotEqual<Equal<ListEnhancementBatchesParams, z.input<typeof listEnhancementBatchesQuerySchema>>>();
// `inventory` is the phone's own PAT-only field; the web's patch never carries it.
assertNotEqual<Equal<MediaSyncConfigPatch, UpdateConfigInput>>();

describe('wire types shared with the contract', () => {
  it('are asserted at compile time (see the assertions above)', () => {
    expect(true).toBe(true);
  });
});
