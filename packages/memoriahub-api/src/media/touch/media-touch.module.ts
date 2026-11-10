import { Module } from '@nestjs/common';

import { MediaTouchService } from './media-touch.service.js';

/**
 * MediaTouchModule (issue #310)
 *
 * Deliberately tiny and dependency-free (the global ports module supplies the
 * database port) so ANY module that mutates sidecar-visible related rows
 * (tagging, face, media itself) can import it without ever closing a module
 * cycle. `MediaModule` re-exports it.
 *
 * @stability experimental
 */
@Module({
  providers: [MediaTouchService],
  exports: [MediaTouchService],
})
export class MediaTouchModule {}
