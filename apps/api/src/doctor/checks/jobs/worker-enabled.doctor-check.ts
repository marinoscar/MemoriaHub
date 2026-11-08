import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { resolveWorkerMode, type EnrichmentWorkerMode } from '../../../enrichment/enrichment-job.worker';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass, warn } from '../outcome';
import { nodeStaleWindowMs } from '../nodes/node-heartbeat-window';
import { AppSystemSettingsService } from '../../../platform/settings/app-system-settings.service';

// Ported from `DoctorService.checkWorkerEnabled` (key `jobs.workerEnabled`).
// READ-ONLY: a settings read and one `count` of fresh worker nodes.
// Retirement: replaced by the jobs slice's checks (RETRO-C1).

/**
 * Heavy media-compute job types a healthy external worker node must serve for a
 * fleet to substitute for the in-process worker (mode 'system'/'off').
 */
export const NODE_HEAVY_MEDIA_TYPES = ['face_detection', 'auto_tagging', 'video_auto_tagging'];

export function decideWorkerEnabled(
  mode: EnrichmentWorkerMode,
  anyEnrichmentFeatureOn: boolean,
  freshNodes: number,
): DoctorCheckOutcome {
  if (mode === 'all') return pass('Enrichment worker is enabled (mode: all).', { mode });

  if (mode === 'system') {
    if (freshNodes > 0) {
      return pass(
        `Enrichment worker is in system mode; ${freshNodes} healthy worker node(s) serving media compute.`,
        { mode, freshNodes },
      );
    }
    if (anyEnrichmentFeatureOn) {
      return warn(
        'Enrichment worker is in system mode but no healthy worker nodes are registered — media enrichment jobs will not be processed.',
        'Start a worker node (memoriahub node start) or set ENRICHMENT_WORKER_MODE=all.',
        { mode, freshNodes },
      );
    }
    return warn(
      'Enrichment worker is in system mode with no healthy worker nodes registered (no enrichment features enabled).',
      'Start a worker node (memoriahub node start) before enabling an enrichment feature, or set ENRICHMENT_WORKER_MODE=all.',
      { mode, freshNodes },
    );
  }

  // mode === 'off'
  if (freshNodes > 0) {
    return warn(
      `Enrichment worker is off; relying entirely on ${freshNodes} external worker node(s) with no server fallback — server-only jobs (purges, sweeps, insights) will not run.`,
      'Consider ENRICHMENT_WORKER_MODE=system so server-only jobs keep running on the API tier.',
      { mode, freshNodes },
    );
  }
  if (anyEnrichmentFeatureOn) {
    return fail(
      'Enrichment worker is off but at least one enrichment feature flag is on, and no healthy worker nodes are registered.',
      'Set ENRICHMENT_WORKER_MODE=all (or =system with a running node fleet) so enrichment jobs get processed.',
      { mode, freshNodes },
    );
  }
  return warn(
    'Enrichment worker is off.',
    'Set ENRICHMENT_WORKER_MODE=all (or =system with a running node fleet) before enabling an enrichment feature.',
    { mode, freshNodes },
  );
}

@Injectable()
export class WorkerEnabledDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('jobs', 'worker-enabled');
  readonly category = 'jobs';
  readonly label = 'Enrichment worker enabled';
  readonly settingsPath = '/admin/settings/jobs';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: AppSystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const mode = resolveWorkerMode();
    if (mode === 'all') return decideWorkerEnabled(mode, false, 0);

    const settings = await this.systemSettings.readKnownValue();
    const anyEnrichmentFeatureOn =
      settings.features?.['autoTagging'] === true ||
      settings.features?.['faceRecognition'] === true ||
      settings.features?.['burstDetection'] === true;

    // In 'system' and 'off' modes, media compute depends on an external node
    // fleet — are there online nodes with a fresh heartbeat that cover at least
    // one heavy media-compute type?
    const cutoff = new Date(Date.now() - nodeStaleWindowMs());
    const freshNodes = await this.prisma.mhLegacyWorkerNode.count({
      where: {
        status: 'online',
        lastHeartbeatAt: { gte: cutoff },
        eligibleTypes: { hasSome: NODE_HEAVY_MEDIA_TYPES },
      },
    });
    return decideWorkerEnabled(mode, anyEnrichmentFeatureOn, freshNodes);
  }
}
