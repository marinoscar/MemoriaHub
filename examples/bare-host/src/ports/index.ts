// =============================================================================
// The bare host's port bindings
// =============================================================================
//
// Every @marinoscar/memoriahub-api slice reaches the outside through the ports of
// `@marinoscar/memoriahub-api/ports`. This host binds all of them to simple local
// adapters (the in-memory kit the package ships for its own tests), so the packages
// boot with no platform package, no database and no network:
//
//   prisma       an in-memory client with the one delegate the fan-out needs
//   jobs         an in-process job runner (`drain()` plays the worker)
//   objectStore  an in-memory object store
//   access       owner-only access policy
//   identity     one fixed principal
//   notify / webhooks / metrics / audit   recorders (no-ops that remember)
//   settings     in-memory namespaces with schemas and defaults
//   secrets      an in-memory secret store
//   ai           a fake model runtime
//
//   tagging/search  the slices' in-memory database kits (a vocabulary, tags, tag status; a media
//                   delegate that records the `where` of every query) merged into the one client
//
// A real host writes its own adapters; the web edition's are in
// apps/api/src/platform-memoriahub/.
// =============================================================================

import { createFakeSearchDb, FakeSearchStore } from '@marinoscar/memoriahub-api/search/testing';
import { createFakeTaggingDb, FakeTaggingStore } from '@marinoscar/memoriahub-api/tagging/testing';
import {
  createFakeMemoriahubPorts,
  fakeMemoriahubBindings,
  FakeMemoriahubPrisma,
  type FakeMemoriahubPorts,
} from '@marinoscar/memoriahub-api/testing';
import type { MemoriahubPortBindings } from '@marinoscar/memoriahub-api/core';
import type { MemoriahubEnqueueInput } from '@marinoscar/memoriahub-api/ports';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** One row of the in-memory `media_face_status` table. */
export interface MediaFaceStatusRow {
  mediaItemId: string;
  status: string;
  faceCount: number;
}

/**
 * The fake client plus the `mediaFaceStatus` delegate the photo upload fan-out writes. A real host
 * binds its generated Prisma client here.
 */
export class BareHostPrisma extends FakeMemoriahubPrisma {
  /** The face status rows by media item id. */
  readonly faceStatuses = new Map<string, MediaFaceStatusRow>();

  /** The `media_face_status` delegate (only `upsert`, the one call the fan-out makes). */
  readonly mediaFaceStatus = {
    upsert: async (args: {
      where: { mediaItemId: string };
      create: MediaFaceStatusRow;
      update: Partial<MediaFaceStatusRow>;
    }): Promise<MediaFaceStatusRow> => {
      const existing = this.faceStatuses.get(args.where.mediaItemId);
      const row = existing ? { ...existing, ...args.update } : { ...args.create };
      this.faceStatuses.set(args.where.mediaItemId, row);
      return row;
    },
  };
}

/** The `features` system namespace this host declares (the slices read it through the settings port). */
export const featuresSchema = z.object({
  faceRecognition: z.boolean(),
  autoTagging: z.boolean(),
  locationGrouping: z.boolean(),
});

/** The bare host's ports: the fakes plus the typed prisma and the slices' in-memory stores. */
export interface BareHostPorts extends FakeMemoriahubPorts {
  prisma: BareHostPrisma;
  /** The tagging slice's store (the vocabulary, the tags, the media rows and their tagging status). */
  taggingStore: FakeTaggingStore;
  /** Every input the jobs port was asked to enqueue (the fake rows keep no priority). */
  enqueued: MemoriahubEnqueueInput[];
  /** The search slice's store (the KNN rows and the `where` clauses the media delegate saw). */
  searchStore: FakeSearchStore;
}

/**
 * The HMAC key of one memories digest signing purpose. A real host derives it from its secrets key; this
 * one is a fixed placeholder, different for each purpose so an image token can never be replayed as an
 * unsubscribe token.
 *
 * @param purpose - `memory-digest-image` or `memory-digest-unsubscribe`.
 * @returns a 32-byte key.
 */
export function bareHostDigestKey(purpose: string): Buffer {
  return createHash('sha256').update(`bare-host placeholder digest key:${purpose}`).digest();
}

/**
 * The `notify` port as a recorder keeps its calls; the memories slice (`memories_ready`) and the tagging
 * doctor checks reach it through the port, so the host needs nothing more to bind it.
 */

/**
 * Builds the ports and declares the settings namespaces the host owns.
 *
 * @returns the ports, ready to bind.
 */
export function createBareHostPorts(): BareHostPorts {
  const ports = createFakeMemoriahubPorts() as BareHostPorts;
  ports.prisma = new BareHostPrisma();
  ports.enqueued = [];
  const enqueue = ports.jobs.enqueue.bind(ports.jobs);
  ports.jobs.enqueue = async (input) => {
    ports.enqueued.push(input);
    return enqueue(input);
  };

  // The tagging and search kits share the media delegate: the tagging rows are the media rows, and the
  // search side records the `where` of every query and counts.
  ports.taggingStore = new FakeTaggingStore();
  ports.searchStore = new FakeSearchStore();
  const tagging = createFakeTaggingDb(ports.taggingStore) as Record<string, any>;
  const search = createFakeSearchDb(ports.searchStore) as Record<string, any>;
  const media = tagging['mediaItem'];
  Object.assign(ports.prisma, tagging, search, {
    mediaItem: {
      ...media,
      async findMany(args: { where: Record<string, unknown> }) {
        ports.searchStore.wheres.push(args.where);
        return media.findMany(args);
      },
      async count(args: { where: Record<string, unknown> }) {
        return (await media.findMany(args)).length;
      },
    },
  });
  ports.settings.registerNamespace({
    scope: 'system',
    name: 'features',
    schema: featuresSchema,
    defaults: { faceRecognition: false, autoTagging: false, locationGrouping: false },
  });
  // The namespaces the tagging and search slices read through the settings port (the model selections and
  // the video parameters); the host owns their schemas, the bare host accepts any object.
  for (const name of ['autoTagging', 'ai']) {
    ports.settings.registerNamespace({ scope: 'system', name, schema: z.record(z.string(), z.unknown()), defaults: {} });
  }
  // A model that answers the 1536-d vectors the embedding table holds.
  ports.ai.vector = Array.from({ length: 1536 }, () => 0.1);
  return ports;
}

/**
 * The `MemoriahubPortsModule.forRoot` bindings of a set of ports.
 *
 * @param ports - the host's ports.
 * @returns one binding per port.
 */
export function bareHostBindings(ports: BareHostPorts): MemoriahubPortBindings {
  return fakeMemoriahubBindings(ports);
}
