import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Readable } from 'node:stream';

import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { MediaThumbnailService, UploadEnrichmentRegistry, UploadEnrichmentService } from '@marinoscar/memoriahub-api/media';
import { FaceMatchingService, PeopleService } from '@marinoscar/memoriahub-api/face';
import { InsightsService } from '@marinoscar/memoriahub-api/insights';
import { LocationGroupResolverService } from '@marinoscar/memoriahub-api/location';
import { DigestTokenService } from '@marinoscar/memoriahub-api/memories';
import { SearchService } from '@marinoscar/memoriahub-api/search';
import { AutoTaggingService, TagLabelsService, TaggingBackfillService } from '@marinoscar/memoriahub-api/tagging';

import { AppModule } from '../src/app.module.js';
import { createBareHostPorts, type BareHostPorts } from '../src/ports/index.js';

/** Invented fixture bytes: not a real image, the host never decodes them. */
const FIXTURE = Buffer.from('bare-host fixture: Person A at Place X, invented data');

describe('bare host (in-memory ports, no platform package)', () => {
  let ports: BareHostPorts;
  let app: INestApplicationContext;

  before(async () => {
    ports = createBareHostPorts();
    app = await NestFactory.createApplicationContext(AppModule.forRoot(ports), { logger: false });
  });

  after(async () => {
    await app.close();
  });

  it('does not have a platform package installed', () => {
    for (const name of ['@marinoscar/platform-api', '@marinoscar/platform-web', '@marinoscar/platform-contract']) {
      assert.throws(() => require.resolve(name), /Cannot find module/, `${name} must not resolve`);
    }
  });

  it('resolves the services every mounted slice exports', () => {
    for (const token of [
      UploadEnrichmentRegistry,
      UploadEnrichmentService,
      MediaThumbnailService,
      PeopleService,
      FaceMatchingService,
      InsightsService,
      LocationGroupResolverService,
    ]) {
      assert.ok(app.get(token, { strict: false }), `${token.name} resolves`);
    }
  });

  it('registers the slices job handlers with the job port', () => {
    for (const type of [
      'face_detection',
      'video_face_detection',
      'face_auto_archive_sweep',
      'storage_insights',
      'location_group_rebuild',
      'auto_tagging',
      'video_auto_tagging',
      'memory_generation',
      'memory_digest',
    ]) {
      assert.ok(ports.jobs.isRegistered(type), `${type} is registered`);
    }
  });

  it('stores a fixture object through the object-store port', async () => {
    const { store } = await ports.objectStore.active();
    await store.upload('bare-host/fixture.bin', Readable.from(FIXTURE), { mimeType: 'application/octet-stream', contentLength: FIXTURE.length });
    const saved = ports.objectStore.activeStore.objects.get('bare-host/fixture.bin');
    assert.deepEqual(saved?.bytes, FIXTURE);
  });

  it('fans a photo upload out to face detection only when the feature is on', async () => {
    const fanout = app.get(UploadEnrichmentService, { strict: false });
    const photo = { id: 'media-1', type: 'photo', circleId: 'library-1', deletedAt: null };

    await fanout.enqueueUploadEnrichment(photo);
    assert.equal(ports.jobs.jobs.filter((j) => j.type === 'face_detection').length, 0, 'the feature is off by default');

    await ports.settings.patchSystem('features', { faceRecognition: true }, { actorUserId: 'user-1' });
    await fanout.enqueueUploadEnrichment(photo);
    const queued = ports.jobs.jobs.filter((j) => j.type === 'face_detection');
    assert.equal(queued.length, 1);
    assert.equal(ports.prisma.faceStatuses.get('media-1')?.status, 'pending');

    // A video does not take the photo fan-out, and a trashed photo takes none.
    await fanout.enqueueUploadEnrichment({ id: 'media-2', type: 'video', circleId: 'library-1', deletedAt: null });
    await fanout.enqueueUploadEnrichment({ id: 'media-3', type: 'photo', circleId: 'library-1', deletedAt: new Date() });
    assert.equal(ports.jobs.jobs.filter((j) => j.type === 'face_detection').length, 1);
  });

  it('runs a job through the in-process runner', async () => {
    const seen: string[] = [];
    ports.jobs.registerHandler({ type: 'bare_host.ping', process: async (job) => void seen.push(job.id) });
    const { id } = await ports.jobs.enqueue({ type: 'bare_host.ping', payload: {} });
    await ports.jobs.drain();
    assert.deepEqual(seen, [id]);
  });

  it('resolves canonical place names as the identity while location grouping is off', async () => {
    const resolver = app.get(LocationGroupResolverService, { strict: false });
    const canonical = await resolver.resolve(
      { geoCountry: 'Country X', geoCountryCode: 'XX', geoAdmin1: 'Region Y', geoLocality: 'Place Z' },
      null,
    );
    assert.deepEqual(canonical, {
      geoCanonicalCountry: 'Country X',
      geoCanonicalAdmin1: 'Region Y',
      geoCanonicalLocality: 'Place Z',
    });
  });

  describe('tagging slice', () => {
    const photo = (id: string, circleId = 'library-1') => ({ id, circleId, type: 'photo', addedById: 'user-1' });

    it('keeps both job types server-only, with their permanent profiles and the shared throttle bucket', () => {
      const registered = ports.jobs.registered;
      for (const type of ['auto_tagging', 'video_auto_tagging']) {
        const handler = registered.get(type);
        assert.ok(handler, `${type} is registered`);
        assert.equal(handler.usesAi, true, `${type} uses AI`);
        assert.equal(handler.nodeResultSchema, undefined, `${type} has no node result schema`);
        assert.equal(handler.persistNodeResult, undefined, `${type} has no node persist`);
        assert.equal(handler.throttleKey, 'tagging');
      }
      assert.deepEqual(registered.get('auto_tagging')?.profile, { maxRuntimeMs: 180_000, maxAttempts: 3 });
      assert.deepEqual(registered.get('video_auto_tagging')?.profile, { maxRuntimeMs: 1_200_000, maxAttempts: 3 });
    });

    it('persists only labels of the vocabulary and keeps a manual tag on a re-run', async () => {
      const store = ports.taggingStore;
      const item = photo('tag-1');
      store.items.set(item.id, item);
      store.addLabel('Beach');
      store.addLabel('Sunset');
      store.addTag(item, 'Sunset', 'manual');
      store.addTag(item, 'Old Ai Tag', 'ai');

      await app.get(AutoTaggingService, { strict: false }).persistAutoTagging(
        { id: 'job-1', mediaItemId: item.id, circleId: item.circleId },
        { rawText: JSON.stringify({ tags: ['beach', 'SUNSET', 'Not In The List'], description: 'Sun and water.' }) },
        { providerKey: 'fake', modelVersion: 'model-a' },
      );

      assert.deepEqual(store.tagsOf(item.id), [
        { name: 'Beach', source: 'ai' },
        { name: 'Sunset', source: 'manual' },
      ]);
    });

    it('a duplicate vocabulary label is a conflict, never a second row', async () => {
      const labels = app.get(TagLabelsService, { strict: false });
      await labels.create({ name: 'Harbor' } as never);
      const error = await labels.create({ name: 'Harbor' } as never).catch((e: unknown) => e);
      assert.equal((error as { getStatus?: () => number }).getStatus?.(), 409);
    });

    it('fans a photo upload out to auto_tagging at priority 20 only while the feature is on', async () => {
      const fanout = app.get(UploadEnrichmentService, { strict: false });
      const tagging = () => ports.enqueued.filter((j) => j.type === 'auto_tagging');
      const before = tagging().length;

      await ports.settings.patchSystem('features', { autoTagging: false }, { actorUserId: 'user-1' });
      await fanout.enqueueUploadEnrichment({ id: 'tag-off', type: 'photo', circleId: 'library-1', deletedAt: null });
      assert.equal(tagging().length, before, 'off: nothing queued');

      await ports.settings.patchSystem('features', { autoTagging: true }, { actorUserId: 'user-1' });
      await fanout.enqueueUploadEnrichment({ id: 'tag-on', type: 'photo', circleId: 'library-1', deletedAt: null });
      await fanout.enqueueUploadEnrichment({ id: 'tag-video', type: 'video', circleId: 'library-1', deletedAt: null });
      const queued = tagging().slice(before);
      assert.equal(queued.length, 1);
      assert.equal(queued[0]?.priority, 20);
      assert.equal(ports.taggingStore.statuses.get('tag-on')?.['status'], 'pending');
      assert.equal(ports.enqueued.filter((j) => j.type === 'video_auto_tagging').length, 0, 'a video takes no photo fan-out');
    });

    it('backfills photos by default and videos only when asked, each routed by its own type', async () => {
      const store = ports.taggingStore;
      store.items.set('bf-p', photo('bf-p', 'library-bf'));
      store.items.set('bf-v', { id: 'bf-v', circleId: 'library-bf', type: 'video' } as never);
      const backfill = app.get(TaggingBackfillService, { strict: false });
      const count = () => ports.enqueued.length;

      const start = count();
      await backfill.backfillCircle('library-bf', {});
      assert.deepEqual(ports.enqueued.slice(start).map((j) => j.type), ['auto_tagging']);

      const next = count();
      await backfill.backfillCircle('library-bf', { mediaTypes: ['photo', 'video'] });
      assert.deepEqual(ports.enqueued.slice(next).map((j) => j.type).sort(), ['auto_tagging', 'video_auto_tagging']);
    });
  });

  describe('search slice', () => {
    const request = (circleId: string, extra: Record<string, unknown> = {}) => ({
      circleId,
      filters: {},
      page: 1,
      pageSize: 20,
      sortBy: 'capturedAt',
      sortOrder: 'desc',
      ...extra,
    });

    it('a caller who is not a member of the scope gets not-found, never results', async () => {
      const search = app.get(SearchService, { strict: false });
      ports.access.addGroup('search-lib', 'Library Alpha', { member: 'viewer' });
      ports.searchStore.wheres.length = 0;

      const error = await search.search(request('search-lib') as never, 'stranger', []).catch((e: unknown) => e);

      assert.equal((error as { getStatus?: () => number }).getStatus?.(), 404);
      assert.deepEqual(ports.searchStore.wheres, []);
    });

    it('binds every query to the scope and to the live rows', async () => {
      const search = app.get(SearchService, { strict: false });
      ports.taggingStore.items.set('s1', { id: 's1', circleId: 'search-lib', type: 'photo' });
      ports.taggingStore.items.set('s2', { id: 's2', circleId: 'search-other', type: 'photo' });
      ports.taggingStore.items.set('s3', { id: 's3', circleId: 'search-lib', type: 'photo', deletedAt: new Date() });
      ports.searchStore.wheres.length = 0;

      const result = await search.search(request('search-lib') as never, 'member', []);

      assert.deepEqual(result.items.map((item: Record<string, unknown>) => item['id']), ['s1']);
      assert.equal(ports.searchStore.wheres[0]?.['circleId'], 'search-lib');
      assert.equal(ports.searchStore.wheres[0]?.['deletedAt'], null);
    });

    it('an unknown filter key is a 400', async () => {
      const search = app.get(SearchService, { strict: false });
      const error = await search.search(request('search-lib', { filters: { nope: 1 } }) as never, 'member', []).catch((e: unknown) => e);
      assert.equal((error as { getStatus?: () => number }).getStatus?.(), 400);
    });
  });

  describe('memories slice', () => {
    it('signs digest tokens with one key per purpose, so an image token is never an unsubscribe token', () => {
      const tokens = app.get(DigestTokenService, { strict: false });
      const image = tokens.signImage('media-1', 7);
      const unsubscribe = tokens.signUnsubscribe('user-1', 7);

      assert.equal(tokens.verifyImage(image), 'media-1');
      assert.equal(tokens.verifyImage(unsubscribe), null, 'an unsubscribe token is not an image token');
      assert.equal(tokens.verifyUnsubscribe(unsubscribe), 'user-1');
      assert.equal(tokens.verifyUnsubscribe(image), null, 'an image token is not an unsubscribe token');
      assert.equal(tokens.verifyImage(`${image}x`), null, 'a tampered token is refused');
    });

    it('keeps both job types server-only, with their permanent profiles', () => {
      const registered = ports.jobs.registered;
      for (const type of ['memory_generation', 'memory_digest']) {
        const handler = registered.get(type);
        assert.ok(handler, `${type} is registered`);
        assert.equal(handler.nodeResultSchema, undefined);
        assert.equal(handler.persistNodeResult, undefined);
      }
      assert.deepEqual(registered.get('memory_generation')?.profile, { maxRuntimeMs: 1_200_000, maxAttempts: 3 });
      assert.deepEqual(registered.get('memory_digest')?.profile, { maxRuntimeMs: 900_000, maxAttempts: 2 });
    });
  });
});
