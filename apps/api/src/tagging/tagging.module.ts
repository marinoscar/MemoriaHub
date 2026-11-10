import { Module } from '@nestjs/common';
import {
  AdminTaggingController,
  TaggingController,
  TaggingModule as TaggingCoreModule,
  TagLabelsController,
} from '@marinoscar/memoriahub-api/tagging';

/**
 * Tagging (RETRO-J7, #618). The auto-tagging and video-tagging handlers and services, the tag
 * vocabulary, the backfill and the photo upload fan-out registration live in
 * `@marinoscar/memoriahub-api/tagging`; they reach the platform only through the ports bound in
 * `platform-memoriahub/`. This module mounts the slice's controllers where the old ones sat (the
 * OpenAPI document follows module order) and re-exports the packaged slice.
 */
@Module({
  imports: [TaggingCoreModule.forRoot()],
  controllers: [TaggingController, TagLabelsController, AdminTaggingController],
  exports: [TaggingCoreModule.forRoot()],
})
export class TaggingModule {}
