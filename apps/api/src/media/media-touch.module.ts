import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaTouchService } from './media-touch.service';

/**
 * MediaTouchModule (issue #310)
 *
 * Deliberately tiny and dependency-free (PrismaModule only) so ANY module that
 * mutates sidecar-visible related rows (tagging, face, media itself) can import
 * it without ever closing a module cycle — the same "imports nothing" rationale
 * as NotificationsModule. MediaModule re-exports this module so existing
 * MediaModule consumers can also resolve MediaTouchService.
 */
@Module({
  imports: [PrismaModule],
  providers: [MediaTouchService],
  exports: [MediaTouchService],
})
export class MediaTouchModule {}
