// =============================================================================
// MediaTouchService (issue #310, epic #308 — Local Media Backup via Worker Nodes)
// =============================================================================
//
// The node backup change feed is keyset-paginated over
// `media_items (updated_at, id)`. Direct MediaItem column writes (description,
// favorite, capturedAt, archive/trash/restore, geo, orientation) bump
// `updatedAt` for free via Prisma's @updatedAt — but sidecar-visible metadata
// that lives in RELATED tables (media_tags, album_items, faces, people) does
// not touch the MediaItem row at all, so those mutations would be invisible to
// an incremental backup scan. This service is the single, explicit
// "propagate a related-row change onto the parent MediaItem" primitive.
//
// Contract:
//   - Best-effort: a failed touch logs a warning and NEVER throws into the
//     caller — a backup-feed bookkeeping failure must not fail a user action.
//   - Deduplicates ids and no-ops on an empty array.
//   - Explicitly sets `updatedAt = new Date()` because `updateMany` does not
//     reliably apply @updatedAt.
//   - Accepts an optional Prisma.TransactionClient so a caller already inside
//     a transaction can keep the touch atomic with its own writes. NOTE: when
//     a tx client is passed, a failed touch statement aborts that transaction
//     at the Postgres level even though this method swallows the error —
//     prefer touching AFTER the transaction commits unless atomicity matters.

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Ids per UPDATE statement — bounds parameter-list size on huge batches. */
const TOUCH_CHUNK_SIZE = 500;

@Injectable()
export class MediaTouchService {
  private readonly logger = new Logger(MediaTouchService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Bump `updatedAt` on the given MediaItem ids so the backup change feed
   * picks them up. Best-effort; never throws.
   */
  async touchMediaItems(
    ids: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;

    const client = tx ?? this.prisma;

    try {
      for (let i = 0; i < unique.length; i += TOUCH_CHUNK_SIZE) {
        const chunk = unique.slice(i, i + TOUCH_CHUNK_SIZE);
        await client.mediaItem.updateMany({
          where: { id: { in: chunk } },
          // Explicit set — updateMany does not reliably apply @updatedAt.
          data: { updatedAt: new Date() },
        });
      }
    } catch (err) {
      this.logger.warn(
        `touchMediaItems: failed to bump updatedAt on ${unique.length} item(s): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
