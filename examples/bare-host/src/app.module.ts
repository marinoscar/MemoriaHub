import { Module, type DynamicModule } from '@nestjs/common';
import { MemoriahubPortsModule } from '@marinoscar/memoriahub-api/core';
import { InsightsModule } from '@marinoscar/memoriahub-api/insights';
import { LocationModule } from '@marinoscar/memoriahub-api/location';
import { MediaModule } from '@marinoscar/memoriahub-api/media';
import {
  ENV_FACE_CONFIG,
  FACE_CONFIG,
  FACE_PERSON_AVATARS,
  FACE_STORAGE_ORG,
  FaceModule,
  type FacePersonAvatars,
  type FaceStorageOrg,
} from '@marinoscar/memoriahub-api/face';

import { bareHostBindings, type BareHostPorts } from './ports/index.js';

/** A host with no account avatars: nothing to refresh, merge or reset. */
const NO_AVATARS: FacePersonAvatars = {
  refreshAvatarsForPerson: async () => undefined,
  carryLinkedUsersOnMerge: async () => 0,
  unlinkUsersFromPerson: async () => ({ unlinkedUserIds: [], resetUserIds: [] }),
  resetAvatarsAfterUnlink: async () => undefined,
};

/** One organization, the single-organization mode of the web edition. */
const SINGLE_ORG: FaceStorageOrg = { get: async () => 'org-bare-host' };

/**
 * The bare host: binds the ports once, then mounts the slices the packages carry today (media, face,
 * insights, location). The dedup slice is left out on purpose: it needs `onnxruntime-node`, which a lean
 * host does not install. It imports no `@marinoscar/platform-*` package.
 */
@Module({})
export class AppModule {
  /**
   * @param ports - the host's ports (kept by the caller, so a test can read what the slices wrote).
   */
  static forRoot(ports: BareHostPorts): DynamicModule {
    return {
      module: AppModule,
      imports: [
        MemoriahubPortsModule.forRoot({ ports: bareHostBindings(ports) }),
        MediaModule.forRoot(),
        FaceModule.forRoot({
          providers: [
            { provide: FACE_CONFIG, useValue: ENV_FACE_CONFIG },
            { provide: FACE_PERSON_AVATARS, useValue: NO_AVATARS },
            { provide: FACE_STORAGE_ORG, useValue: SINGLE_ORG },
          ],
        }),
        InsightsModule.forRoot(),
        LocationModule.forRoot(),
      ],
    };
  }
}
