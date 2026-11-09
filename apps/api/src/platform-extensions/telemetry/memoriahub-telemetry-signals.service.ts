// =============================================================================
// MemoriaHub's telemetry reads, shared by the gauges and the verdict (RETRO-T3)
// =============================================================================
//
// One place for every PostgreSQL read behind MemoriaHub's dashboard numbers:
//
//   backlog       storage objects not ready, by status      (gauge + verdict)
//   pending       enrichment items pending, by stage        (gauge)
//   storage       latest insights snapshot breakdown        (gauges)
//   capabilities  online nodes per capability, ok/missing   (gauge)
//   verdict       per-type failures, oldest pending upload jobs, fleet state
//
// Each read is memoized for 60 s (`memoizedRead`), so the gauges and the verdict
// never query more than once a minute between them. Every backlog read also
// appends a sample to an in-memory window, which is what lets the verdict judge
// a backlog that is SUSTAINED rather than a single point.
//
// The verdict signals are refreshed in the background: `verdictSignals()` returns
// the last snapshot at once (the policy is synchronous) and starts a refresh.
// =============================================================================

import { Injectable, Logger, Optional } from '@nestjs/common';
import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../../prisma/prisma.service';
import { readNodeCapabilities, type CapabilityCounts } from './gauges/fleet.gauges';
import { memoizedRead, type MemoizedRead } from './gauges/memoized-read';
import {
  readEnrichmentPending,
  readProcessingBacklog,
  type BacklogCounts,
  type PendingCounts,
} from './gauges/pipeline.gauges';
import { readStorageSnapshot, type StorageReading } from './gauges/storage.gauges';
import {
  MEMORIAHUB_ENRICHMENT_JOB_TYPES,
  MEMORIAHUB_UPLOAD_JOB_TYPES,
  MEMORIAHUB_VERDICT_RULES,
} from './memoriahub-verdict-rules';

/** What the verdict rules judge. */
export interface MemoriaHubVerdictSignals {
  /** When the signals were read (epoch ms). */
  at: number;
  /** Settled jobs per MemoriaHub enrichment type in the window. */
  settled: Array<{ type: string; succeeded: number; failed: number }>;
  /** Age of the oldest due pending job per upload-time type (types with none pending are absent). */
  oldestPending: Array<{ type: string; ageMinutes: number }>;
  /** `processing` backlog samples over the window, oldest first. */
  backlogSamples: Array<{ at: number; processing: number }>;
  /** Registered and online worker nodes, and pending jobs of node-eligible types. */
  fleet: { registered: number; online: number; nodeEligiblePending: number };
}

@Injectable()
export class MemoriaHubTelemetrySignals {
  private readonly logger = new Logger(MemoriaHubTelemetrySignals.name);
  private samples: Array<{ at: number; processing: number }> = [];
  private latest: MemoriaHubVerdictSignals | null = null;
  /** The clock (a test seam). */
  now: () => number = Date.now;

  readonly backlog: MemoizedRead<BacklogCounts>;
  readonly pending: MemoizedRead<PendingCounts>;
  readonly storage: MemoizedRead<StorageReading | null>;
  readonly capabilities: MemoizedRead<CapabilityCounts>;
  private readonly verdictRead: MemoizedRead<MemoriaHubVerdictSignals>;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly jobHandlers?: JobHandlerRegistry,
  ) {
    const options = { now: () => this.now(), logger: this.logger };
    this.backlog = memoizedRead(
      'media.processing.backlog',
      async () => {
        const counts = await readProcessingBacklog(this.prisma);
        this.recordBacklogSample(counts.processing);
        return counts;
      },
      options,
    );
    this.pending = memoizedRead('enrichment.pending', () => readEnrichmentPending(this.prisma), options);
    this.storage = memoizedRead('storage.snapshot', () => readStorageSnapshot(this.prisma), options);
    this.capabilities = memoizedRead('nodes.capability', () => readNodeCapabilities(this.prisma), options);
    this.verdictRead = memoizedRead('verdict', () => this.readVerdictSignals(), options);
  }

  /**
   * The latest verdict signals (possibly up to a minute old, `null` until the
   * first read finished) and a background refresh. Never throws.
   */
  verdictSignals(): MemoriaHubVerdictSignals | null {
    void this.verdictRead.get().then((signals) => {
      if (signals) this.latest = signals;
    });
    return this.latest;
  }

  /** Waits for a fresh read (tests, and the first summary after boot if a caller wants it). */
  async refreshVerdictSignals(): Promise<MemoriaHubVerdictSignals | null> {
    const signals = await this.verdictRead.get();
    if (signals) this.latest = signals;
    return this.latest;
  }

  private recordBacklogSample(processing: number): void {
    const at = this.now();
    const horizon = at - MEMORIAHUB_VERDICT_RULES.windowMinutes * 60_000;
    this.samples = [...this.samples.filter((sample) => sample.at >= horizon), { at, processing }];
  }

  private nodeEligibleTypes(): string[] {
    if (!this.jobHandlers) return [];
    const serverOnly = new Set(this.jobHandlers.serverOnlyTypes());
    return this.jobHandlers.types().filter((type) => !serverOnly.has(type));
  }

  private async readVerdictSignals(): Promise<MemoriaHubVerdictSignals> {
    const at = this.now();
    const since = new Date(at - MEMORIAHUB_VERDICT_RULES.windowMinutes * 60_000);
    const nodeEligible = this.nodeEligibleTypes();

    // Jobs CREATED in the window that have settled: bounded by `jobs(created_at DESC)`,
    // so the read never scans the whole retained history.
    const [settledRows, pendingRows, registered, online, nodeEligiblePending] = await Promise.all([
      this.prisma.job.groupBy({
        by: ['type', 'status'],
        where: {
          createdAt: { gte: since },
          type: { in: [...MEMORIAHUB_ENRICHMENT_JOB_TYPES] },
          status: { in: ['succeeded', 'failed'] },
        },
        _count: { _all: true },
      }),
      this.prisma.job.groupBy({
        by: ['type'],
        where: {
          status: 'pending',
          type: { in: [...MEMORIAHUB_UPLOAD_JOB_TYPES] },
          OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date(at) } }],
        },
        _min: { createdAt: true },
      }),
      this.prisma.workerNode.count(),
      this.prisma.workerNode.count({ where: { status: 'online' } }),
      nodeEligible.length > 0
        ? this.prisma.job.count({ where: { status: 'pending', type: { in: nodeEligible } } })
        : Promise.resolve(0),
    ]);
    // A sample for the sustained-backlog rule even when no gauge exported.
    await this.backlog.get();

    const settled = new Map<string, { type: string; succeeded: number; failed: number }>();
    for (const row of settledRows) {
      const entry = settled.get(row.type) ?? { type: row.type, succeeded: 0, failed: 0 };
      if (row.status === 'succeeded') entry.succeeded += row._count._all;
      else if (row.status === 'failed') entry.failed += row._count._all;
      settled.set(row.type, entry);
    }
    const oldestPending = pendingRows
      .filter((row) => row._min.createdAt)
      .map((row) => ({ type: row.type, ageMinutes: (at - row._min.createdAt!.getTime()) / 60_000 }));

    return {
      at,
      settled: [...settled.values()],
      oldestPending,
      backlogSamples: [...this.samples],
      fleet: { registered, online, nodeEligiblePending },
    };
  }
}
