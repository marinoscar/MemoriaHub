/**
 * Unit tests for WorkflowActionExecutor (issue #140).
 *
 * Covers the full action library. Every reused domain service (MediaService,
 * MediaEnrichmentService, PeopleService, BurstService, DuplicateService,
 * LocationSuggestionService, EnrichmentJobService, CircleMembershipService) is
 * a jest mock -- the executor's OWN logic (result-status mapping, group dedup
 * via ctx.handledGroups, the move_to_circle cross-circle cascade, the
 * album-name-cache, error->failed conversion) is what's under test, not the
 * reused services' internals (those have their own unit suites).
 *
 * No database required -- PrismaService is a deep mock; $transaction is wired
 * to invoke its callback with the same mock (mirrors mockPrismaTransaction()).
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaTagSource, MediaType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { WorkflowActionExecutor } from './workflow-action.executor';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../media/media.service';
import { MediaEnrichmentService } from '../../media/enrichment/media-enrichment.service';
import { PeopleService } from '../../face/people.service';
import { BurstService } from '../../burst/burst.service';
import { DuplicateService } from '../../dedup/duplicate.service';
import { LocationSuggestionService } from '../../location-inference/location-suggestion.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { WorkflowAction, WorkflowActionContext } from './action-executor.types';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const RUN_ID = randomUUID();
const CIRCLE_ID = randomUUID();
const OTHER_CIRCLE_ID = randomUUID();
const ACTOR_ID = randomUUID();
const ITEM_ID = randomUUID();

function action(type: string, params: Record<string, unknown> = {}): WorkflowAction {
  return { type, params };
}

describe('WorkflowActionExecutor', () => {
  let executor: WorkflowActionExecutor;
  let prisma: MockPrismaService;
  let media: jest.Mocked<
    Pick<
      MediaService,
      | 'bulkDelete'
      | 'purgeMediaItems'
      | 'bulkArchive'
      | 'bulkUnarchive'
      | 'addAlbumItems'
      | 'createAlbum'
      | 'removeAlbumItem'
      | 'bulkTags'
      | 'bulkUpdateMedia'
    >
  >;
  let enrichment: jest.Mocked<Pick<MediaEnrichmentService, 'enqueueUploadEnrichment'>>;
  let people: jest.Mocked<Pick<PeopleService, 'addPersonToMedia' | 'removePersonFromMedia'>>;
  let burst: jest.Mocked<Pick<BurstService, 'resolveBurstGroup' | 'dismissBurstGroup'>>;
  let duplicate: jest.Mocked<Pick<DuplicateService, 'resolveDuplicateGroup' | 'dismissDuplicateGroup'>>;
  let locationSuggestions: jest.Mocked<Pick<LocationSuggestionService, 'acceptSuggestion' | 'rejectSuggestion'>>;
  let enrichmentJobs: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;
  let membership: jest.Mocked<Pick<CircleMembershipService, 'assertCircleAccess'>>;
  let ctx: WorkflowActionContext;

  beforeEach(() => {
    prisma = createMockPrismaService();
    prisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );

    media = {
      bulkDelete: jest.fn().mockResolvedValue({ deleted: 1 }),
      purgeMediaItems: jest.fn().mockResolvedValue(1),
      bulkArchive: jest.fn().mockResolvedValue({ archived: 1 }),
      bulkUnarchive: jest.fn().mockResolvedValue({ unarchived: 1 }),
      addAlbumItems: jest.fn().mockResolvedValue({ added: 1 }),
      createAlbum: jest.fn().mockResolvedValue({ id: randomUUID() }),
      removeAlbumItem: jest.fn().mockResolvedValue(undefined),
      bulkTags: jest.fn().mockResolvedValue({ added: 1, removed: 1 }),
      bulkUpdateMedia: jest.fn().mockResolvedValue({ updated: 1 }),
    };
    enrichment = { enqueueUploadEnrichment: jest.fn().mockResolvedValue(undefined) };
    people = {
      addPersonToMedia: jest.fn().mockResolvedValue({
        personId: randomUUID(),
        personName: 'Alice',
        faceId: randomUUID(),
        mediaItemId: ITEM_ID,
      }),
      removePersonFromMedia: jest.fn().mockResolvedValue({ deleted: 1 }),
    };
    burst = {
      resolveBurstGroup: jest.fn().mockResolvedValue({}),
      dismissBurstGroup: jest.fn().mockResolvedValue({}),
    };
    duplicate = {
      resolveDuplicateGroup: jest.fn().mockResolvedValue({}),
      dismissDuplicateGroup: jest.fn().mockResolvedValue({}),
    };
    locationSuggestions = {
      acceptSuggestion: jest.fn().mockResolvedValue({}),
      rejectSuggestion: jest.fn().mockResolvedValue({}),
    };
    enrichmentJobs = { enqueue: jest.fn().mockResolvedValue({ id: randomUUID() }) };
    membership = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };

    executor = new WorkflowActionExecutor(
      prisma as unknown as PrismaService,
      media as unknown as MediaService,
      enrichment as unknown as MediaEnrichmentService,
      people as unknown as PeopleService,
      burst as unknown as BurstService,
      duplicate as unknown as DuplicateService,
      locationSuggestions as unknown as LocationSuggestionService,
      enrichmentJobs as unknown as EnrichmentJobService,
      membership as unknown as CircleMembershipService,
    );

    ctx = {
      runId: RUN_ID,
      circleId: CIRCLE_ID,
      actorUserId: ACTOR_ID,
      actorPermissions: ['media:write', 'media:delete'],
      handledGroups: new Set<string>(),
    };
  });

  // ---------------------------------------------------------------------------
  // Unknown action / generic error handling
  // ---------------------------------------------------------------------------

  it('returns failed for an unrecognized action type', async () => {
    const outcome = await executor.execute(action('teleport_item'), { id: ITEM_ID }, ctx);
    expect(outcome).toEqual({ status: 'failed', detail: 'Unknown action type "teleport_item"' });
  });

  it('converts a thrown error from a reused service into a failed outcome', async () => {
    media.bulkArchive.mockRejectedValue(new Error('db exploded'));
    const outcome = await executor.execute(action('archive'), { id: ITEM_ID }, ctx);
    expect(outcome).toEqual({ status: 'failed', detail: 'db exploded' });
  });

  // ---------------------------------------------------------------------------
  // move_to_trash / hard_delete / archive / unarchive
  // ---------------------------------------------------------------------------

  describe('move_to_trash', () => {
    it('applied when an item is deleted', async () => {
      media.bulkDelete.mockResolvedValue({ deleted: 1 });
      const outcome = await executor.execute(action('move_to_trash'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'applied' });
      expect(media.bulkDelete).toHaveBeenCalledWith(
        { circleId: CIRCLE_ID, ids: [ITEM_ID] },
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('skipped (noop) when nothing was deleted', async () => {
      media.bulkDelete.mockResolvedValue({ deleted: 0 });
      const outcome = await executor.execute(action('move_to_trash'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'skipped', reason: 'noop' });
    });
  });

  describe('hard_delete', () => {
    it('applied + terminal:true when the item was purged', async () => {
      media.purgeMediaItems.mockResolvedValue(1);
      const outcome = await executor.execute(action('hard_delete'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'applied', terminal: true });
      expect(media.purgeMediaItems).toHaveBeenCalledWith([ITEM_ID]);
    });

    it('skipped (not_found) when nothing was purged', async () => {
      media.purgeMediaItems.mockResolvedValue(0);
      const outcome = await executor.execute(action('hard_delete'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'skipped', reason: 'not_found' });
    });
  });

  describe('archive / unarchive', () => {
    it('archive applied when an item was archived', async () => {
      media.bulkArchive.mockResolvedValue({ archived: 1 });
      expect(await executor.execute(action('archive'), { id: ITEM_ID }, ctx)).toEqual({
        status: 'applied',
      });
    });

    it('archive skipped (noop) when nothing was archived', async () => {
      media.bulkArchive.mockResolvedValue({ archived: 0 });
      expect(await executor.execute(action('archive'), { id: ITEM_ID }, ctx)).toEqual({
        status: 'skipped',
        reason: 'noop',
      });
    });

    it('unarchive applied when an item was unarchived', async () => {
      media.bulkUnarchive.mockResolvedValue({ unarchived: 1 });
      expect(await executor.execute(action('unarchive'), { id: ITEM_ID }, ctx)).toEqual({
        status: 'applied',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // add_to_album / remove_from_album
  // ---------------------------------------------------------------------------

  describe('add_to_album', () => {
    it('adds directly to an existing albumId', async () => {
      const albumId = randomUUID();
      const outcome = await executor.execute(
        action('add_to_album', { albumId }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'applied' });
      expect(media.addAlbumItems).toHaveBeenCalledWith(
        albumId,
        { mediaItemIds: [ITEM_ID] },
        ACTOR_ID,
        ctx.actorPermissions,
      );
      expect(media.createAlbum).not.toHaveBeenCalled();
    });

    it('creates a new album on first use of createAlbumNamed and reuses it for a second item in the same run', async () => {
      const newAlbumId = randomUUID();
      media.createAlbum.mockResolvedValue({ id: newAlbumId } as any);

      await executor.execute(action('add_to_album', { createAlbumNamed: 'Trip' }), { id: ITEM_ID }, ctx);
      const item2 = randomUUID();
      await executor.execute(action('add_to_album', { createAlbumNamed: 'Trip' }), { id: item2 }, ctx);

      expect(media.createAlbum).toHaveBeenCalledTimes(1); // find-or-create cache hit on 2nd call
      expect(media.addAlbumItems).toHaveBeenNthCalledWith(
        1,
        newAlbumId,
        { mediaItemIds: [ITEM_ID] },
        ACTOR_ID,
        ctx.actorPermissions,
      );
      expect(media.addAlbumItems).toHaveBeenNthCalledWith(
        2,
        newAlbumId,
        { mediaItemIds: [item2] },
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('the album-name cache is scoped per runId (a different run creates its own album)', async () => {
      media.createAlbum
        .mockResolvedValueOnce({ id: 'album-run-1' } as any)
        .mockResolvedValueOnce({ id: 'album-run-2' } as any);

      await executor.execute(action('add_to_album', { createAlbumNamed: 'Trip' }), { id: ITEM_ID }, ctx);

      const otherRunCtx: WorkflowActionContext = { ...ctx, runId: randomUUID() };
      await executor.execute(
        action('add_to_album', { createAlbumNamed: 'Trip' }),
        { id: ITEM_ID },
        otherRunCtx,
      );

      expect(media.createAlbum).toHaveBeenCalledTimes(2);
    });

    it('clearRunCache releases a run’s album-name cache', async () => {
      media.createAlbum.mockResolvedValue({ id: 'album-1' } as any);
      await executor.execute(action('add_to_album', { createAlbumNamed: 'Trip' }), { id: ITEM_ID }, ctx);
      executor.clearRunCache(RUN_ID);
      await executor.execute(action('add_to_album', { createAlbumNamed: 'Trip' }), { id: ITEM_ID }, ctx);
      expect(media.createAlbum).toHaveBeenCalledTimes(2);
    });
  });

  describe('remove_from_album', () => {
    it('applied when the item was removed', async () => {
      const albumId = randomUUID();
      const outcome = await executor.execute(
        action('remove_from_album', { albumId }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'applied' });
    });

    it('skipped (not_in_album) on NotFoundException', async () => {
      media.removeAlbumItem.mockRejectedValue(new NotFoundException('not a member'));
      const outcome = await executor.execute(
        action('remove_from_album', { albumId: randomUUID() }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'not_in_album' });
    });

    it('rethrows (failed) a non-NotFound error', async () => {
      media.removeAlbumItem.mockRejectedValue(new Error('unexpected'));
      const outcome = await executor.execute(
        action('remove_from_album', { albumId: randomUUID() }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'failed', detail: 'unexpected' });
    });
  });

  // ---------------------------------------------------------------------------
  // add_tags / remove_tags
  // ---------------------------------------------------------------------------

  describe('add_tags', () => {
    it('applies and writes with source=system', async () => {
      media.bulkTags.mockResolvedValue({ added: 2, removed: 0 } as any);
      const outcome = await executor.execute(
        action('add_tags', { names: ['sunset', 'beach'] }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'applied' });
      expect(media.bulkTags).toHaveBeenCalledWith(
        { circleId: CIRCLE_ID, ids: [ITEM_ID], add: ['sunset', 'beach'] },
        ACTOR_ID,
        ctx.actorPermissions,
        { addSource: MediaTagSource.system },
      );
    });

    it('skipped (noop) when nothing was added', async () => {
      media.bulkTags.mockResolvedValue({ added: 0, removed: 0 } as any);
      const outcome = await executor.execute(
        action('add_tags', { names: ['x'] }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'noop' });
    });
  });

  describe('remove_tags', () => {
    it('honors the sources param, defaulting to [ai, system]', async () => {
      media.bulkTags.mockResolvedValue({ added: 0, removed: 1 } as any);
      const outcome = await executor.execute(
        action('remove_tags', { names: ['spam'], sources: ['ai', 'system'] }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'applied' });
      expect(media.bulkTags).toHaveBeenCalledWith(
        { circleId: CIRCLE_ID, ids: [ITEM_ID], remove: ['spam'] },
        ACTOR_ID,
        ctx.actorPermissions,
        { removeSources: ['ai', 'system'] },
      );
    });

    it('passes through an explicit ["manual"] sources list -- never silently widened or narrowed', async () => {
      media.bulkTags.mockResolvedValue({ added: 0, removed: 1 } as any);
      await executor.execute(
        action('remove_tags', { names: ['oops'], sources: ['manual'] }),
        { id: ITEM_ID },
        ctx,
      );
      expect(media.bulkTags).toHaveBeenCalledWith(
        expect.anything(),
        ACTOR_ID,
        ctx.actorPermissions,
        { removeSources: ['manual'] },
      );
    });

    it('skipped (noop) when nothing was removed', async () => {
      media.bulkTags.mockResolvedValue({ added: 0, removed: 0 } as any);
      const outcome = await executor.execute(
        action('remove_tags', { names: ['x'], sources: ['ai'] }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'noop' });
    });
  });

  // ---------------------------------------------------------------------------
  // set_favorite
  // ---------------------------------------------------------------------------

  describe('set_favorite', () => {
    it('applied', async () => {
      media.bulkUpdateMedia.mockResolvedValue({ updated: 1 } as any);
      const outcome = await executor.execute(action('set_favorite', { value: true }), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'applied' });
      expect(media.bulkUpdateMedia).toHaveBeenCalledWith(
        { circleId: CIRCLE_ID, ids: [ITEM_ID], set: { favorite: true } },
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('skipped (noop)', async () => {
      media.bulkUpdateMedia.mockResolvedValue({ updated: 0 } as any);
      const outcome = await executor.execute(action('set_favorite', { value: false }), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'skipped', reason: 'noop' });
    });
  });

  // ---------------------------------------------------------------------------
  // set_captured_at (set / shift / clear)
  // ---------------------------------------------------------------------------

  describe('set_captured_at', () => {
    it('mode "set" writes the absolute ISO date', async () => {
      media.bulkUpdateMedia.mockResolvedValue({ updated: 1 } as any);
      const outcome = await executor.execute(
        action('set_captured_at', { mode: 'set', value: '2024-06-01T12:00:00.000Z' }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'applied' });
      expect(media.bulkUpdateMedia).toHaveBeenCalledWith(
        {
          circleId: CIRCLE_ID,
          ids: [ITEM_ID],
          set: { capturedAt: new Date('2024-06-01T12:00:00.000Z') },
        },
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('mode "clear" nulls capturedAt', async () => {
      media.bulkUpdateMedia.mockResolvedValue({ updated: 1 } as any);
      await executor.execute(action('set_captured_at', { mode: 'clear' }), { id: ITEM_ID }, ctx);
      expect(media.bulkUpdateMedia).toHaveBeenCalledWith(
        { circleId: CIRCLE_ID, ids: [ITEM_ID], set: { capturedAt: null } },
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('mode "shift" adds shiftMinutes to the item’s current capturedAt', async () => {
      const base = new Date('2024-06-01T12:00:00.000Z');
      prisma.mediaItem.findUnique.mockResolvedValue({ capturedAt: base } as any);
      media.bulkUpdateMedia.mockResolvedValue({ updated: 1 } as any);

      await executor.execute(action('set_captured_at', { mode: 'shift', shiftMinutes: 90 }), { id: ITEM_ID }, ctx);

      const expected = new Date(base.getTime() + 90 * 60_000);
      expect(media.bulkUpdateMedia).toHaveBeenCalledWith(
        { circleId: CIRCLE_ID, ids: [ITEM_ID], set: { capturedAt: expected } },
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('mode "shift" subtracts for a negative shiftMinutes', async () => {
      const base = new Date('2024-06-01T12:00:00.000Z');
      prisma.mediaItem.findUnique.mockResolvedValue({ capturedAt: base } as any);
      media.bulkUpdateMedia.mockResolvedValue({ updated: 1 } as any);

      await executor.execute(action('set_captured_at', { mode: 'shift', shiftMinutes: -30 }), { id: ITEM_ID }, ctx);

      const expected = new Date(base.getTime() - 30 * 60_000);
      expect(media.bulkUpdateMedia).toHaveBeenCalledWith(
        { circleId: CIRCLE_ID, ids: [ITEM_ID], set: { capturedAt: expected } },
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('mode "shift" on an item with a NULL capturedAt is skipped, not errored', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({ capturedAt: null } as any);
      const outcome = await executor.execute(
        action('set_captured_at', { mode: 'shift', shiftMinutes: 60 }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'null_captured_at' });
      expect(media.bulkUpdateMedia).not.toHaveBeenCalled();
    });

    it('mode "shift" on a since-deleted item (findUnique -> null) is skipped, not errored', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(null);
      const outcome = await executor.execute(
        action('set_captured_at', { mode: 'shift', shiftMinutes: 60 }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'null_captured_at' });
    });
  });

  // ---------------------------------------------------------------------------
  // assign_person / remove_person
  // ---------------------------------------------------------------------------

  describe('assign_person / remove_person', () => {
    it('assign_person applied', async () => {
      const personId = randomUUID();
      const outcome = await executor.execute(action('assign_person', { personId }), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'applied' });
      expect(people.addPersonToMedia).toHaveBeenCalledWith(ITEM_ID, ACTOR_ID, ctx.actorPermissions, {
        personId,
      });
    });

    it('remove_person applied', async () => {
      const personId = randomUUID();
      const outcome = await executor.execute(action('remove_person', { personId }), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'applied' });
    });

    it('remove_person skipped (no_association) on NotFoundException', async () => {
      people.removePersonFromMedia.mockRejectedValue(new NotFoundException('none'));
      const outcome = await executor.execute(
        action('remove_person', { personId: randomUUID() }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'no_association' });
    });
  });

  // ---------------------------------------------------------------------------
  // set_location / clear_location
  // ---------------------------------------------------------------------------

  describe('set_location / clear_location', () => {
    it('set_location applied', async () => {
      media.bulkUpdateMedia.mockResolvedValue({ updated: 1 } as any);
      const outcome = await executor.execute(
        action('set_location', { lat: 9.93, lng: -84.09 }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'applied' });
      expect(media.bulkUpdateMedia).toHaveBeenCalledWith(
        { circleId: CIRCLE_ID, ids: [ITEM_ID], set: { location: { lat: 9.93, lng: -84.09 } } },
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('clear_location applied, routes location:null through bulkUpdateMedia', async () => {
      media.bulkUpdateMedia.mockResolvedValue({ updated: 1 } as any);
      const outcome = await executor.execute(action('clear_location'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'applied' });
      expect(media.bulkUpdateMedia).toHaveBeenCalledWith(
        { circleId: CIRCLE_ID, ids: [ITEM_ID], set: { location: null } },
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // move_to_circle
  // ---------------------------------------------------------------------------

  describe('move_to_circle', () => {
    it('skips with reason same_circle when the target equals the source circle', async () => {
      const outcome = await executor.execute(
        action('move_to_circle', { targetCircleId: CIRCLE_ID }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'same_circle' });
      expect(membership.assertCircleAccess).not.toHaveBeenCalled();
    });

    it('re-checks collaborator access on BOTH source and target circles', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({
        id: ITEM_ID,
        type: MediaType.photo,
        contentHash: null,
        deletedAt: null,
      } as any);
      prisma.mediaItem.findFirst.mockResolvedValue(null); // no dedup collision

      await executor.execute(action('move_to_circle', { targetCircleId: OTHER_CIRCLE_ID }), { id: ITEM_ID }, ctx);

      expect(membership.assertCircleAccess).toHaveBeenCalledWith(
        ACTOR_ID,
        CIRCLE_ID,
        ctx.actorPermissions,
        'collaborator',
      );
      expect(membership.assertCircleAccess).toHaveBeenCalledWith(
        ACTOR_ID,
        OTHER_CIRCLE_ID,
        ctx.actorPermissions,
        'collaborator',
      );
    });

    it('fails when the actor lacks target-circle collaborator access', async () => {
      membership.assertCircleAccess.mockImplementation(async (_u, circleId) => {
        if (circleId === OTHER_CIRCLE_ID) {
          throw new BadRequestException('no target access');
        }
        return { role: 'collaborator', isSuperAdmin: false };
      });

      const outcome = await executor.execute(
        action('move_to_circle', { targetCircleId: OTHER_CIRCLE_ID }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'failed', detail: 'no target access' });
    });

    it('skips with reason not_found when the item is gone or already deleted', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({
        id: ITEM_ID,
        type: MediaType.photo,
        contentHash: 'hash',
        deletedAt: new Date(),
      } as any);

      const outcome = await executor.execute(
        action('move_to_circle', { targetCircleId: OTHER_CIRCLE_ID }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'not_found' });
    });

    it('skips with reason dedup_conflict when an active item with the same content hash already exists in the target circle', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({
        id: ITEM_ID,
        type: MediaType.photo,
        contentHash: 'abc123',
        deletedAt: null,
      } as any);
      prisma.mediaItem.findFirst.mockResolvedValue({ id: randomUUID() } as any); // collision found

      const outcome = await executor.execute(
        action('move_to_circle', { targetCircleId: OTHER_CIRCLE_ID }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'dedup_conflict' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('clears source-side associations (album, faces, tags, location suggestion), reassigns circleId, and re-enqueues enrichment in the target circle', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({
        id: ITEM_ID,
        type: MediaType.video,
        contentHash: null,
        deletedAt: null,
      } as any);
      prisma.mediaItem.findFirst.mockResolvedValue(null);
      prisma.albumItem.deleteMany.mockResolvedValue({ count: 1 } as any);
      prisma.face.deleteMany.mockResolvedValue({ count: 2 } as any);
      prisma.mediaTag.deleteMany.mockResolvedValue({ count: 1 } as any);
      prisma.locationSuggestion.deleteMany.mockResolvedValue({ count: 1 } as any);
      prisma.mediaItem.update.mockResolvedValue({} as any);

      const outcome = await executor.execute(
        action('move_to_circle', { targetCircleId: OTHER_CIRCLE_ID }),
        { id: ITEM_ID },
        ctx,
      );

      expect(outcome).toEqual({ status: 'applied' });
      expect(prisma.albumItem.deleteMany).toHaveBeenCalledWith({ where: { mediaItemId: ITEM_ID } });
      expect(prisma.face.deleteMany).toHaveBeenCalledWith({ where: { mediaItemId: ITEM_ID } });
      expect(prisma.mediaTag.deleteMany).toHaveBeenCalledWith({ where: { mediaItemId: ITEM_ID } });
      expect(prisma.locationSuggestion.deleteMany).toHaveBeenCalledWith({ where: { mediaItemId: ITEM_ID } });
      expect(prisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: ITEM_ID },
        data: { circleId: OTHER_CIRCLE_ID, burstGroupId: null, duplicateGroupId: null },
      });
      expect(enrichment.enqueueUploadEnrichment).toHaveBeenCalledWith({
        id: ITEM_ID,
        type: MediaType.video,
        circleId: OTHER_CIRCLE_ID,
        deletedAt: null,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // rerun_enrichment
  // ---------------------------------------------------------------------------

  describe('rerun_enrichment', () => {
    it('enqueues auto_tagging for kind "tagging" at priority 100', async () => {
      const outcome = await executor.execute(
        action('rerun_enrichment', { kinds: ['tagging'] }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'applied' });
      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'auto_tagging', mediaItemId: ITEM_ID, circleId: CIRCLE_ID, priority: 100 }),
      );
    });

    it('routes "faces" to face_detection for a photo', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({ type: MediaType.photo } as any);
      await executor.execute(action('rerun_enrichment', { kinds: ['faces'] }), { id: ITEM_ID }, ctx);
      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'face_detection' }),
      );
    });

    it('routes "faces" to video_face_detection for a video', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({ type: MediaType.video } as any);
      await executor.execute(action('rerun_enrichment', { kinds: ['faces'] }), { id: ITEM_ID }, ctx);
      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'video_face_detection' }),
      );
    });

    it('skips (not_found) when kinds includes "faces" but the item no longer exists', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(null);
      const outcome = await executor.execute(
        action('rerun_enrichment', { kinds: ['faces'] }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'not_found' });
    });

    it('enqueues one job per kind for multiple kinds', async () => {
      await executor.execute(
        action('rerun_enrichment', { kinds: ['tagging', 'metadata', 'thumbnail', 'duplicates'] }),
        { id: ITEM_ID },
        ctx,
      );
      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(4);
      const types = (enrichmentJobs.enqueue as jest.Mock).mock.calls.map((c) => c[0].type);
      expect(types.sort()).toEqual(
        ['auto_tagging', 'duplicate_detection', 'metadata_extraction', 'thumbnail_regen'].sort(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Review-queue actions: group dedup + only-if-pending semantics
  // ---------------------------------------------------------------------------

  describe('resolve_burst_group / dismiss_burst_group', () => {
    it('resolves a pending group, keeping only the suggested-best member', async () => {
      const groupId = randomUUID();
      const bestId = randomUUID();
      prisma.mediaItem.findUnique.mockResolvedValue({
        burstGroupId: groupId,
        burstGroup: { status: 'pending', suggestedBestItemId: bestId },
      } as any);

      const outcome = await executor.execute(
        action('resolve_burst_group', { action: 'archive' }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'applied' });
      expect(burst.resolveBurstGroup).toHaveBeenCalledWith(
        groupId,
        { keepIds: [bestId], action: 'archive' },
        ACTOR_ID,
        ctx.actorPermissions,
      );
      expect(ctx.handledGroups.has(groupId)).toBe(true);
    });

    it('skips (no_pending_target) when the item has no burst group', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({ burstGroupId: null, burstGroup: null } as any);
      const outcome = await executor.execute(
        action('resolve_burst_group', { action: 'archive' }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'no_pending_target' });
      expect(burst.resolveBurstGroup).not.toHaveBeenCalled();
    });

    it('skips (no_pending_target) when the group is already resolved/dismissed', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({
        burstGroupId: randomUUID(),
        burstGroup: { status: 'resolved', suggestedBestItemId: randomUUID() },
      } as any);
      const outcome = await executor.execute(
        action('resolve_burst_group', { action: 'archive' }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'no_pending_target' });
    });

    it('skips (same_group) a second item that shares an already-handled group within the same run', async () => {
      const groupId = randomUUID();
      const bestId = randomUUID();
      prisma.mediaItem.findUnique.mockResolvedValue({
        burstGroupId: groupId,
        burstGroup: { status: 'pending', suggestedBestItemId: bestId },
      } as any);

      await executor.execute(action('resolve_burst_group', { action: 'archive' }), { id: ITEM_ID }, ctx);
      const outcome2 = await executor.execute(
        action('resolve_burst_group', { action: 'archive' }),
        { id: randomUUID() },
        ctx,
      );

      expect(outcome2).toEqual({ status: 'skipped', reason: 'same_group' });
      expect(burst.resolveBurstGroup).toHaveBeenCalledTimes(1); // group resolved exactly once
    });

    it('skips (no_suggested_best) when the pending group lacks a suggested-best item', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({
        burstGroupId: randomUUID(),
        burstGroup: { status: 'pending', suggestedBestItemId: null },
      } as any);
      const outcome = await executor.execute(
        action('resolve_burst_group', { action: 'archive' }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'no_suggested_best' });
    });

    it('fails when the trash variant is used without media:delete permission (mirrors BurstService’s own guard)', async () => {
      const groupId = randomUUID();
      const bestId = randomUUID();
      prisma.mediaItem.findUnique.mockResolvedValue({
        burstGroupId: groupId,
        burstGroup: { status: 'pending', suggestedBestItemId: bestId },
      } as any);
      const noDeleteCtx: WorkflowActionContext = { ...ctx, actorPermissions: ['media:write'] };
      burst.resolveBurstGroup.mockImplementation(async (_id, dto, _u, perms) => {
        if ((dto as any).action === 'trash' && !perms.includes('media:delete')) {
          throw new BadRequestException('media:delete permission is required to trash burst items');
        }
        return { data: { removed: 0, kept: 0, action: dto.action, groupStatus: 'resolved' } };
      });

      const outcome = await executor.execute(
        action('resolve_burst_group', { action: 'trash' }),
        { id: ITEM_ID },
        noDeleteCtx,
      );
      expect(outcome).toEqual({
        status: 'failed',
        detail: 'media:delete permission is required to trash burst items',
      });
    });

    it('dismiss_burst_group applied when pending', async () => {
      const groupId = randomUUID();
      prisma.mediaItem.findUnique.mockResolvedValue({
        burstGroupId: groupId,
        burstGroup: { status: 'pending' },
      } as any);
      const outcome = await executor.execute(action('dismiss_burst_group'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'applied' });
      expect(burst.dismissBurstGroup).toHaveBeenCalledWith(groupId, ACTOR_ID, ctx.actorPermissions);
      expect(ctx.handledGroups.has(groupId)).toBe(true);
    });

    it('dismiss_burst_group skips (same_group) a second item in the already-handled group', async () => {
      const groupId = randomUUID();
      prisma.mediaItem.findUnique.mockResolvedValue({
        burstGroupId: groupId,
        burstGroup: { status: 'pending' },
      } as any);
      await executor.execute(action('dismiss_burst_group'), { id: ITEM_ID }, ctx);
      const outcome2 = await executor.execute(action('dismiss_burst_group'), { id: randomUUID() }, ctx);
      expect(outcome2).toEqual({ status: 'skipped', reason: 'same_group' });
    });
  });

  describe('resolve_duplicate_group / dismiss_duplicate_group', () => {
    it('resolves a pending group, keeping only the suggested-best member', async () => {
      const groupId = randomUUID();
      const bestId = randomUUID();
      prisma.mediaItem.findUnique.mockResolvedValue({
        duplicateGroupId: groupId,
        duplicateGroup: { status: 'pending', suggestedBestItemId: bestId },
      } as any);

      const outcome = await executor.execute(
        action('resolve_duplicate_group', { action: 'trash' }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'applied' });
      expect(duplicate.resolveDuplicateGroup).toHaveBeenCalledWith(
        groupId,
        { keepIds: [bestId], action: 'trash' },
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('skips (no_pending_target) with no duplicate group', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({
        duplicateGroupId: null,
        duplicateGroup: null,
      } as any);
      const outcome = await executor.execute(
        action('resolve_duplicate_group', { action: 'archive' }),
        { id: ITEM_ID },
        ctx,
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'no_pending_target' });
    });

    it('skips (same_group) a second item sharing an already-handled group', async () => {
      const groupId = randomUUID();
      const bestId = randomUUID();
      prisma.mediaItem.findUnique.mockResolvedValue({
        duplicateGroupId: groupId,
        duplicateGroup: { status: 'pending', suggestedBestItemId: bestId },
      } as any);
      await executor.execute(action('resolve_duplicate_group', { action: 'archive' }), { id: ITEM_ID }, ctx);
      const outcome2 = await executor.execute(
        action('resolve_duplicate_group', { action: 'archive' }),
        { id: randomUUID() },
        ctx,
      );
      expect(outcome2).toEqual({ status: 'skipped', reason: 'same_group' });
      expect(duplicate.resolveDuplicateGroup).toHaveBeenCalledTimes(1);
    });

    it('dismiss_duplicate_group applied when pending', async () => {
      const groupId = randomUUID();
      prisma.mediaItem.findUnique.mockResolvedValue({
        duplicateGroupId: groupId,
        duplicateGroup: { status: 'pending' },
      } as any);
      const outcome = await executor.execute(action('dismiss_duplicate_group'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'applied' });
      expect(duplicate.dismissDuplicateGroup).toHaveBeenCalledWith(groupId, ACTOR_ID, ctx.actorPermissions);
    });

    it('dismiss_duplicate_group skips (no_pending_target) when already dismissed', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue({
        duplicateGroupId: randomUUID(),
        duplicateGroup: { status: 'dismissed' },
      } as any);
      const outcome = await executor.execute(action('dismiss_duplicate_group'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'skipped', reason: 'no_pending_target' });
    });
  });

  // ---------------------------------------------------------------------------
  // accept_location_suggestion / reject_location_suggestion
  // ---------------------------------------------------------------------------

  describe('accept_location_suggestion / reject_location_suggestion', () => {
    it('accept applied when a pending suggestion exists', async () => {
      const suggestionId = randomUUID();
      prisma.locationSuggestion.findUnique.mockResolvedValue({
        id: suggestionId,
        status: 'pending',
      } as any);

      const outcome = await executor.execute(action('accept_location_suggestion'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'applied' });
      expect(locationSuggestions.acceptSuggestion).toHaveBeenCalledWith(
        suggestionId,
        {},
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('accept skips (no_pending_target) when no suggestion row exists', async () => {
      prisma.locationSuggestion.findUnique.mockResolvedValue(null);
      const outcome = await executor.execute(action('accept_location_suggestion'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'skipped', reason: 'no_pending_target' });
    });

    it('accept skips (no_pending_target) when the suggestion is already resolved', async () => {
      prisma.locationSuggestion.findUnique.mockResolvedValue({
        id: randomUUID(),
        status: 'accepted',
      } as any);
      const outcome = await executor.execute(action('accept_location_suggestion'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'skipped', reason: 'no_pending_target' });
    });

    it('reject applied when a pending suggestion exists', async () => {
      const suggestionId = randomUUID();
      prisma.locationSuggestion.findUnique.mockResolvedValue({
        id: suggestionId,
        status: 'pending',
      } as any);
      const outcome = await executor.execute(action('reject_location_suggestion'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'applied' });
      expect(locationSuggestions.rejectSuggestion).toHaveBeenCalledWith(
        suggestionId,
        ACTOR_ID,
        ctx.actorPermissions,
      );
    });

    it('reject skips (no_pending_target) when no suggestion row exists', async () => {
      prisma.locationSuggestion.findUnique.mockResolvedValue(null);
      const outcome = await executor.execute(action('reject_location_suggestion'), { id: ITEM_ID }, ctx);
      expect(outcome).toEqual({ status: 'skipped', reason: 'no_pending_target' });
    });
  });
});
