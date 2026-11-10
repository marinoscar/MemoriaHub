// =============================================================================
// describeFaceSliceConformance against the face slice over the in-memory fakes (RETRO-J6, #615)
// =============================================================================
//
// The services are RESOLVED from the real Nest module (`FaceModule.forRoot` over
// `MemoriahubPortsModule.forRoot`), so the run also proves the slice's wiring: every provider
// resolves from the ports and the three host tokens alone, and the three handlers register with the
// queue when the module starts.
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import { UploadEnrichmentRegistry } from '../src/media/index.js';
import {
  FACE_CONFIG,
  FACE_PERSON_AVATARS,
  FACE_STORAGE_ORG,
  FaceClusteringService,
  FaceDetectionService,
  FaceMatchingService,
  FaceModule,
  type FaceConfigReader,
} from '../src/face/index.js';
import { describeFaceSliceConformance, faceFixtureVector, installFakeFaceStore } from '../src/face/testing/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

const APP_BACKEND: FaceConfigReader = {
  get: <T = string>(key: string): T | undefined => (key === 'FACE_VECTOR_BACKEND' ? ('app' as unknown as T) : undefined),
};

async function faceSliceOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  const store = installFakeFaceStore(fakes.prisma);

  const moduleRef = await Test.createTestingModule({
    imports: [
      MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }),
      FaceModule.forRoot({
        providers: [
          { provide: FACE_CONFIG, useValue: APP_BACKEND },
          {
            provide: FACE_PERSON_AVATARS,
            useValue: {
              refreshAvatarsForPerson: async () => undefined,
              carryLinkedUsersOnMerge: async () => 0,
              unlinkUsersFromPerson: async () => ({ unlinkedUserIds: [], resetUserIds: [] }),
              resetAvatarsAfterUnlink: async () => undefined,
            },
          },
          { provide: FACE_STORAGE_ORG, useValue: { get: async () => 'org-1' } },
        ],
      }),
    ],
  }).compile();
  await moduleRef.init();

  const matching = moduleRef.get(FaceMatchingService);
  const seedFace = (row: Record<string, unknown>) => store.face.rows.push(row);

  return {
    jobs: { handlers: fakes.jobs.registered, uploadRegistry: moduleRef.get(UploadEnrichmentRegistry) },
    rerun: {
      service: moduleRef.get(FaceDetectionService),
      circleId: 'circle-1',
      mediaItemId: 'item-1',
      seedFaces: (faces: ReadonlyArray<{ key: string; manuallyAssigned: boolean }>) => {
        for (const f of faces) seedFace({ id: f.key, mediaItemId: 'item-1', manuallyAssigned: f.manuallyAssigned, circleId: 'circle-1' });
      },
      faceKeys: () => store.face.rows.filter((r) => r.mediaItemId === 'item-1').map((r) => r.id as string),
    },
    clustering: {
      service: moduleRef.get(FaceClusteringService),
      circleId: 'circle-1',
      userId: 'user-1',
      seedFaces: (faces: ReadonlyArray<{ key: string; embedding: number[]; hidden: boolean }>) => {
        for (const f of faces) {
          seedFace({ id: f.key, circleId: 'circle-1', personId: null, embedding: f.embedding, hiddenAt: f.hidden ? new Date() : null, manuallyAssigned: false });
        }
      },
      personOf: (key: string) => (store.face.rows.find((r) => r.id === key)?.personId as string | null | undefined) ?? null,
    },
    autoArchive: {
      service: matching,
      circleId: 'circle-1',
      seedPool: (embedding: number[]) => {
        seedFace({ id: 'face-archived', circleId: 'circle-1', personId: null, embedding, hiddenAt: new Date() });
        seedFace({ id: 'face-live', circleId: 'circle-1', personId: null, embedding, hiddenAt: null });
        seedFace({ id: 'face-assigned', circleId: 'circle-1', personId: 'person-x', embedding, hiddenAt: new Date() });
        return 'face-archived';
      },
    },
    knn: {
      backends: [{ name: 'app', service: matching }],
      circleId: 'circle-1',
      seedPeople: () => {
        const circleId = 'circle-1';
        const ids = ['person-a', 'person-b', 'person-c'];
        ids.forEach((id, i) => {
          store.person.rows.push({ id, circleId, deletedAt: null, mergedIntoId: null });
          const axis = [2, 11, 40][i]!;
          for (const n of [1, 2]) seedFace({ id: `${id}-face-${n}`, circleId, personId: id, embedding: faceFixtureVector(axis, 0.02 * n) });
        });
        return ids;
      },
    },
  };
}

describeFaceSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: faceSliceOverFakes });

describe('FaceModule.forRoot', () => {
  it('names one module however often it is called', () => {
    const a = FaceModule.forRoot({ providers: [] });
    expect(FaceModule.forRoot({ providers: [] })).toBe(a);
  });
});
