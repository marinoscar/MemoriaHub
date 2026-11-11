// =============================================================================
// Memories Module: the web app's binding of the memories slice (epic #300; RETRO-J8, #619)
// =============================================================================
//
// The slice (curation, the seven curators, AI titles, the digest, the `memories_ready` producer, the
// generation and digest jobs, the read API) lives in `@marinoscar/memoriahub-api/memories`. This module
// supplies what is the web app's own and mounts the slice's controllers (not registered by
// `forRoot()`, which would change the OpenAPI path order):
//
//   * MEMORIES_ALBUMS           save-as-album over `MediaService` (platform-memoriahub/memories/)
//   * MEMORIES_EMAIL_READINESS  the platform email settings (the digest cron's gate)
//   * MEMORIES_GENERATION_HOOK  `MemoriaHubWebhooks.memoriesCreated` (the `memories.memory.created` event)
//   * digest.signingKey         `deriveSubKey(purpose)`: derived from `SECRETS_ENCRYPTION_KEY`, so a
//                               token minted before the move still verifies (the key never enters the package)
//
// The edges are one-way: MediaModule (the album code) and the email module import nothing of Memories.
// =============================================================================

import { Module } from '@nestjs/common';
import {
  AdminMemoriesController,
  MEMORIES_ALBUMS,
  MEMORIES_EMAIL_READINESS,
  MEMORIES_GENERATION_HOOK,
  MemoriesController,
  MemoriesModule as MemoriesSliceModule,
  PublicMemoryDigestController,
} from '@marinoscar/memoriahub-api/memories';
import { MediaModule as MediaCoreModule } from '@marinoscar/memoriahub-api/media';

import { deriveSubKey } from '../legacy/legacy-secret-cipher';
import { MediaModule } from '../media/media.module';
import { emailModule } from '../platform/email/email.config';
import { MemoriaHubWebhooks } from '../platform/webhooks/memoriahub-webhooks.service';
import { MemoriesAlbumsAdapter } from '../platform-memoriahub/memories/memories-albums.adapter';
import { PlatformMemoriesEmailReadiness } from '../platform-memoriahub/memories/memories-email-readiness';

const memoriesSlice = MemoriesSliceModule.forRoot({
  digest: { signingKey: (purpose) => deriveSubKey(purpose) },
  imports: [MediaModule, emailModule],
  providers: [
    MemoriesAlbumsAdapter,
    PlatformMemoriesEmailReadiness,
    { provide: MEMORIES_ALBUMS, useExisting: MemoriesAlbumsAdapter },
    { provide: MEMORIES_EMAIL_READINESS, useExisting: PlatformMemoriesEmailReadiness },
    { provide: MEMORIES_GENERATION_HOOK, useExisting: MemoriaHubWebhooks },
  ],
});

@Module({
  imports: [memoriesSlice, MediaCoreModule.forRoot()],
  controllers: [MemoriesController, AdminMemoriesController, PublicMemoryDigestController],
  exports: [memoriesSlice],
})
export class MemoriesModule {}
