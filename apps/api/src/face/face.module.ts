import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminFaceBackfillController,
  FACE_CONFIG,
  FACE_PERSON_AVATARS,
  FACE_STORAGE_ORG,
  FaceDetectionController,
  FaceModule as PackagedFaceModule,
  FaceSettingsController,
  PeopleController,
} from '@marinoscar/memoriahub-api/face';
import { DefaultOrgId } from '../common/tenancy/default-org-id';
import { videoJobTimeoutMs } from '../platform/jobs/legacy-env';
import { MediaModule } from '../media/media.module';
import { ProfileModule } from '../profile/profile.module';
import { UserAvatarService } from '../profile/user-avatar.service';
// The face compute (frame extraction, image preparation) logs through the compute logger this wires to
// Nest's. Importing it here keeps the wiring in place even when no other media module is loaded first.
import '../media-processing/image-orientation.util';

/**
 * The packaged face slice (`@marinoscar/memoriahub-api/face`, RETRO-J6): face detection in photos and
 * videos, matching, clustering, people and auto-archive, with its three job handlers
 * (`face_detection`, `video_face_detection`, `face_auto_archive_sweep`) and the photo upload fan-out.
 * It reaches the platform only through the `MEMORIAHUB_*` ports (`PlatformMemoriahubModule`) and three
 * host tokens bound here:
 *
 *   FACE_CONFIG          the deployment configuration (`FACE_MATCH_THRESHOLD`, `FACE_VECTOR_BACKEND`, ...)
 *   FACE_PERSON_AVATARS  the profile slice's avatar code (an account can be linked to a person)
 *   FACE_STORAGE_ORG     the organization a video face frame is stamped with
 *
 * What stays here is the mounting: the four controllers (`@MemoriahubAuth` over the identity port) are the
 * slice's; this module lists them so their routes live where they always did. ProfileModule is imported for
 * issue #354: PeopleService propagates a person's profile-picture change to any account linked to that person. The edge points
 * FaceModule -> ProfileModule; ProfileModule must never import FaceModule back.
 */
const packagedFace = PackagedFaceModule.forRoot({
  providers: [
    { provide: FACE_CONFIG, useExisting: ConfigService },
    { provide: FACE_PERSON_AVATARS, useExisting: UserAvatarService },
    { provide: FACE_STORAGE_ORG, useExisting: DefaultOrgId },
  ],
  imports: [ProfileModule],
  videoJobTimeoutMs: videoJobTimeoutMs(),
});

@Module({
  imports: [packagedFace, MediaModule],
  controllers: [FaceSettingsController, FaceDetectionController, PeopleController, AdminFaceBackfillController],
  exports: [packagedFace],
})
export class FaceModule {}
