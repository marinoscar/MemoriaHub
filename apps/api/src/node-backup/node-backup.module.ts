// =============================================================================
// NodeBackupModule: Local Media Backup via worker nodes (epic #308; RETRO-C2, #581)
// =============================================================================
//
// The app-owned half of the node plane. The fleet itself (register, claim, credentials, the
// admin routes) is the platform's `NodesModule` (`platform/jobs/jobs.config.ts`); this module
// serves `/api/nodes/:id/backup/*` on top of it. The routes fall under the platform's
// `NODE_ROUTE_PREFIX`, so a `nod_` credential reaches them (and nothing else of the app);
// the node is resolved by id and caller in `NodeBackupOwnershipService` (404 for an unknown node and
// for another user's node; the platform's `@NodeRoute()` guard answers 403 for a foreign node).
// =============================================================================

import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { Module } from '@nestjs/common';

import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NodeBackupController } from './node-backup.controller';
import { NodeBackupQueryService } from './node-backup-query.service';
import { NodeBackupOwnershipService } from './node-backup-ownership.service';
import { NodeBackupService } from './node-backup.service';
import { NodeBackupStaleHandler } from './node-backup-stale.handler';
import { NodeBackupStaleTask } from './node-backup-stale.task';

/**
 * Imports MediaProcessingModule (exports StorageProviderResolver) so the change feed can
 * presign downloads from the provider each object lives on.
 */
@Module({
  imports: [PrismaModule, MediaProcessingModule, OwnerAccessModule],
  controllers: [NodeBackupController],
  providers: [
    NodeBackupOwnershipService,
    NodeBackupQueryService,
    NodeBackupService,
    NodeBackupStaleTask,
    // RETRO-C9 (#612): the cron only enqueues; this does the sweep.
    NodeBackupStaleHandler,
  ],
  exports: [NodeBackupQueryService],
})
export class NodeBackupModule {}
