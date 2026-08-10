import { Module } from '@nestjs/common';
import { CirclesModule } from '../circles/circles.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { UserProfileController } from './user-profile.controller';
import { UserAvatarService } from './user-avatar.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Imports added for profile picture management (issue #354):
 *   - StorageProvidersModule: StorageProviderResolver, for writing/reading the
 *     rendered avatar object.
 *   - CirclesModule: CircleMembershipService.assertCircleAccess, to validate a
 *     person link against the caller's circle membership.
 *   - SettingsModule: UserSettingsService, which stays the single writer of
 *     User.displayName (via its syncDisplayName).
 *
 * No cycle: none of those three reaches back into UsersModule. FaceModule
 * imports THIS module (for UserAvatarService's person hooks), so the edge runs
 * FaceModule -> UsersModule and must not be reversed.
 *
 * Controller order is deliberate — see the header on UserProfileController: its
 * literal `me/...` paths are registered before UsersController's `:id` routes.
 */
@Module({
  imports: [StorageProvidersModule, CirclesModule, SettingsModule],
  controllers: [UserProfileController, UsersController],
  providers: [UsersService, UserAvatarService],
  exports: [UsersService, UserAvatarService],
})
export class UsersModule {}
