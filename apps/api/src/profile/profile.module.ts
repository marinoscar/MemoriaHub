import { Injectable, Module } from '@nestjs/common';

import { bindIdentityExtensionClient } from '../app-registrations/identity';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { PrismaService } from '../prisma/prisma.service';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { UserAvatarService } from './user-avatar.service';
import { UserProfileController } from './user-profile.controller';

/**
 * Hands the Prisma client to MemoriaHub's `GET /api/auth/me` extension (the raw
 * `timezone`). The extension is registered at import time, before any provider
 * exists; the client is bound here, once the container has built it.
 */
@Injectable()
export class IdentityExtensionBinder {
  constructor(prisma: PrismaService) {
    bindIdentityExtensionClient(prisma);
  }
}

/**
 * The app-owned half of the user (RETRO-B2, issue #611): the profile picture
 * and the account-to-person link, over the `user_profiles` side table. The users
 * list, roles, allowlist, tokens and device flow are the identity slice's.
 *
 * Imports (profile picture management, issue #354):
 *   - MediaProcessingModule: StorageProviderResolver, for the rendered avatar.
 *   - OwnerAccessModule: OwnerAccessService.requireOwnerRole, to validate a
 *     person link against the caller's circle membership.
 *   - SettingsModule: UserSettingsService, the single writer of
 *     User.displayName (via its syncDisplayName).
 *
 * No cycle: none of those reaches back into ProfileModule. FaceModule imports
 * THIS module (for UserAvatarService's person hooks), so the edge runs
 * FaceModule -> ProfileModule and must not be reversed.
 *
 * ROUTES: `users/me/...` and `users/:id/avatar` share the `users` prefix with
 * the identity slice's `users/:id` routes; the literal `me` segment is matched
 * before any parametric route.
 */
@Module({
  imports: [MediaProcessingModule, OwnerAccessModule, ],
  controllers: [UserProfileController],
  providers: [UserAvatarService, IdentityExtensionBinder],
  exports: [UserAvatarService],
})
export class ProfileModule {}
