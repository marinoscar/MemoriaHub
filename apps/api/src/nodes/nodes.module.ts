import { Module } from '@nestjs/common';
import { NodesService } from './nodes.service';
import { NodesController } from './nodes.controller';
import { NodesAdminController } from './nodes-admin.controller';
import { NodeCredentialsController } from './node-credentials.controller';
import { NodeCredentialModule } from './node-credential.module';
import { NodeOfflinePruneTask } from './node-offline-prune.task';
import { PrismaModule } from '../prisma/prisma.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageModule } from '../storage/storage.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { AiModule } from '../ai/ai.module';
import { SettingsModule } from '../settings/settings.module';
import { TaggingModule } from '../tagging/tagging.module';

/**
 * Imports StorageProvidersModule (exports StorageProviderResolver) so
 * NodesService can resolve the active storage provider for
 * `POST /nodes/:id/jobs/:jobId/upload-url` — the presigned PUT URL a node
 * uses to upload a computed thumbnail directly to the same
 * provider/bucket new uploads land in, mirroring
 * ThumbnailProcessor.uploadThumbnail's provider resolution.
 *
 * Also imports AiModule (AiSettingsService — resolveCredentials),
 * SettingsModule (SystemSettingsService — active tagging/geo provider config),
 * and TaggingModule (AutoTaggingService — shared prompt builder) so
 * `POST /nodes/:id/jobs/:jobId/credentials` can resolve TRANSIENT, per-job
 * provider credentials for the auto_tagging/geocode job types without a node
 * ever seeing the server's stored credential row directly.
 */
@Module({
  imports: [
    PrismaModule,
    EnrichmentModule,
    StorageModule,
    StorageProvidersModule,
    AiModule,
    SettingsModule,
    TaggingModule,
    // Global module providing NodeCredentialService (nod_ bearer tokens) —
    // kept separate + @Global so JwtAuthGuard can inject it in every module
    // context, mirroring the PatModule wiring.
    NodeCredentialModule,
  ],
  controllers: [NodesController, NodesAdminController, NodeCredentialsController],
  providers: [NodesService, NodeOfflinePruneTask],
})
export class NodesModule {}
