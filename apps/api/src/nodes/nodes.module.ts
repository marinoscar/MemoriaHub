import { GeoLocationModule } from '../media/geo/geo-location.module';
import { Module } from '@nestjs/common';
import { NodesService } from './nodes.service';
import { NodeBackupQueryService } from './node-backup-query.service';
import { NodeBackupService } from './node-backup.service';
import { NodeBackupController } from './node-backup.controller';
import { NodeBackupStaleTask } from './node-backup-stale.task';
import { NodeBackupStaleHandler } from './node-backup-stale.handler';
import { NodesController } from './nodes.controller';
import { NodesAdminController } from './nodes-admin.controller';
import { NodeCredentialsController } from './node-credentials.controller';
import { NodeCredentialModule } from './node-credential.module';
import { NodeOfflinePruneTask } from './node-offline-prune.task';
import { NodeStaleOfflineTask } from './node-stale-offline.task';
import { PrismaModule } from '../prisma/prisma.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { AiModule } from '../ai/ai.module';
import { TaggingModule } from '../tagging/tagging.module';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

/**
 * Imports MediaProcessingModule (exports StorageProviderResolver) so
 * NodesService can resolve the active storage provider for
 * `POST /nodes/:id/jobs/:jobId/upload-url` — the presigned PUT URL a node
 * uses to upload a computed thumbnail directly to the same
 * provider/bucket new uploads land in, mirroring
 * ThumbnailProcessor.uploadThumbnail's provider resolution.
 *
 * Also imports AiModule (AiSettingsService — resolveCredentials),
 * SettingsModule (AppSystemSettingsService — active tagging/geo provider config),
 * and TaggingModule (AutoTaggingService — shared prompt builder) so
 * `POST /nodes/:id/jobs/:jobId/credentials` can resolve TRANSIENT, per-job
 * provider credentials for the auto_tagging/geocode job types without a node
 * ever seeing the server's stored credential row directly.
 */
@Module({
  imports: [
    PrismaModule,
    EnrichmentModule,
    MediaProcessingModule,
    AiModule,
    
    TaggingModule,
    // Google key for the transient geocode credential (RETRO-B4)
    GeoLocationModule,
    // Global module providing NodeCredentialService (nod_ bearer tokens) —
    // kept separate + @Global so JwtAuthGuard can inject it in every module
    // context, mirroring the PatModule wiring.
    NodeCredentialModule,
  ],
  controllers: [
    NodesController,
    NodeBackupController,
    NodesAdminController,
    NodeCredentialsController,
  ],
  providers: [
    NodesService,
    NodeOfflinePruneTask,
    // Flips crashed/killed nodes to status='offline' so the admin fleet view
    // stops contradicting itself AND NodeOfflinePruneTask above can actually
    // reach them (it selects only status='offline') — issue #438 defect 6.
    NodeStaleOfflineTask,
    NodeBackupQueryService,
    NodeBackupService,
    NodeBackupStaleTask,
    // RETRO-C9 (#612): the cron only enqueues; this does the sweep.
    NodeBackupStaleHandler,
  ],
  exports: [NodeBackupQueryService],
})
export class NodesModule {}
