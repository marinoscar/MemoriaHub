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
    for (const type of ['face_detection', 'video_face_detection', 'face_auto_archive_sweep', 'storage_insights', 'location_group_rebuild']) {
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
});
