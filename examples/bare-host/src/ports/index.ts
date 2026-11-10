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
// A real host writes its own adapters; the web edition's are in
// apps/api/src/platform-memoriahub/.
// =============================================================================

import {
  createFakeMemoriahubPorts,
  fakeMemoriahubBindings,
  FakeMemoriahubPrisma,
  type FakeMemoriahubPorts,
} from '@marinoscar/memoriahub-api/testing';
import type { MemoriahubPortBindings } from '@marinoscar/memoriahub-api/core';
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

/** The bare host's ports: the fakes plus the typed prisma. */
export interface BareHostPorts extends FakeMemoriahubPorts {
  prisma: BareHostPrisma;
}

/**
 * Builds the ports and declares the settings namespaces the host owns.
 *
 * @returns the ports, ready to bind.
 */
export function createBareHostPorts(): BareHostPorts {
  const ports = createFakeMemoriahubPorts() as BareHostPorts;
  ports.prisma = new BareHostPrisma();
  ports.settings.registerNamespace({
    scope: 'system',
    name: 'features',
    schema: featuresSchema,
    defaults: { faceRecognition: false, autoTagging: false, locationGrouping: false },
  });
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
