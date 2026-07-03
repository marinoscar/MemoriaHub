// =============================================================================
// Doctor Service
// =============================================================================
//
// On-demand configuration health sweep for admins. Runs a fixed catalog of
// checks across core infra, auth, storage, AI, face, geo, and the job queue —
// concurrently, with a per-check timeout and exception normalization. No
// result is persisted; every call recomputes the report from scratch.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { FaceSettingsService } from '../face/face-settings.service';
import { GeoSettingsService } from '../geo/geo-settings.service';
import { StorageSettingsService } from '../storage-settings/storage-settings.service';
import { EnrichmentAdminService } from '../enrichment/enrichment-admin.service';
import { DoctorReport } from './doctor.types';

@Injectable()
export class DoctorService {
  private readonly logger = new Logger(DoctorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly aiSettings: AiSettingsService,
    private readonly faceSettings: FaceSettingsService,
    private readonly geoSettings: GeoSettingsService,
    private readonly storageSettings: StorageSettingsService,
    private readonly enrichmentAdmin: EnrichmentAdminService,
  ) {}

  /**
   * Run the full diagnostics sweep.
   *
   * TODO: this is a scaffolding stub — the 20-check catalog is implemented in
   * a follow-up commit. Returns a structurally valid, empty report for now.
   */
  async runDiagnostics(): Promise<DoctorReport> {
    const start = Date.now();
    this.logger.debug('Doctor: runDiagnostics stub invoked');

    return {
      computedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      summary: { ok: 0, warning: 0, error: 0, skipped: 0, total: 0 },
      sections: [],
    };
  }
}
