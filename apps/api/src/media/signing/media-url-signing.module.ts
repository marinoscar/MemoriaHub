import { Module } from '@nestjs/common';
import { MediaUrlSigningService } from './media-url-signing.service';

/**
 * MediaUrlSigningModule
 *
 * Provides the lightweight MediaUrlSigningService (depends only on the global
 * ConfigService) so that any module which produces browser-facing media URLs
 * (media, search, burst, dedup, face, location-inference) can route them
 * through the same-origin byte-proxy. Kept dependency-free to avoid import
 * cycles between those feature modules.
 */
@Module({
  providers: [MediaUrlSigningService],
  exports: [MediaUrlSigningService],
})
export class MediaUrlSigningModule {}
