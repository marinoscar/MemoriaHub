// =============================================================================
// Stand-ins for the platform services the MemoriaHub port adapters sit on (RETRO-J4, #610)
// =============================================================================
//
// `ports-conformance.spec.ts` runs the same kit the package runs against its fakes
// (`describeMemoriahubPortsConformance`) against each REAL adapter in `src/platform-memoriahub/`. What is
// real: the adapters, `JobHandlerRegistry`, `ProviderThrottleService`, `EventEmitter2`, the platform
// registries (`findEvent`, `aiFeatureRegistry`, `storageKeyPrefixRegistry`, ...), `OwnerAccessService`,
// `RecordAccessService`, `OwnerScopeSweepService`, and the platform helpers the adapters call. What is a
// stand-in: the I/O underneath them (the `jobs` table, the model provider, the storage driver, the
// membership read, the credential rows, the settings rows). The real-database half is
// `ports-conformance.db.spec.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  JOB_SETTLED_EVENT,
  JobHandlerRegistry,
  ProviderThrottleService,
  RateLimitError,
  buildDedupKey,
  type Job,
} from '@marinoscar/platform-api/jobs';
import type { StorageProvider } from '@marinoscar/platform-api/storage';
import { ConfigService } from '@nestjs/config';

/** A `jobs` row of the stand-in queue. */
export type StandInJob = Job & { dedupKey: string | null };

/**
 * The slice of the `jobs` table the jobs adapter reads and writes, plus a worker: the platform
 * `JobsService`, the `prisma.job` delegate and the claim loop in one object, with the platform's own
 * dedup rule (one pending or running row per dedup key) and its retry, deferral and settled-event rules.
 */
export class StandInQueue {
  readonly rows: StandInJob[] = [];

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly throttle: ProviderThrottleService,
    private readonly events: EventEmitter2,
  ) {}

  /** `JobsService.enqueue`. */
  async enqueue(input: {
    type: string;
    reason: string;
    subjectType?: string | null;
    subjectId?: string | null;
    payload?: unknown;
    priority?: number;
    scheduledFor?: Date | null;
    skipDedup?: boolean;
    orgId?: string | null;
  }): Promise<Job> {
    const dedupKey = input.skipDedup === true ? null : buildDedupKey(input.type, input.subjectType ?? undefined, input.subjectId ?? undefined);
    if (dedupKey !== null) {
      const active = this.rows.find((row) => row.dedupKey === dedupKey && (row.status === 'pending' || row.status === 'running'));
      if (active) return active;
    }
    const row = {
      id: randomUUID(),
      type: input.type,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      dedupKey,
      status: 'pending',
      reason: input.reason,
      priority: input.priority ?? 0,
      providerKey: null,
      payload: input.payload ?? null,
      attempts: 0,
      scheduledFor: input.scheduledFor ?? null,
      lastError: null,
      orgId: input.orgId ?? null,
      createdAt: new Date(),
    } as unknown as StandInJob;
    this.rows.push(row);
    return row;
  }

  /** `JobsService.enqueueWithin` (no transaction to join). */
  enqueueWithin(_tx: unknown, input: Parameters<StandInQueue['enqueue']>[0]): Promise<Job> {
    return this.enqueue(input);
  }

  /** `JobsService.recordProvider`. */
  async recordProvider(jobId: string, providerKey: string | null): Promise<void> {
    const row = this.rows.find((r) => r.id === jobId);
    if (row) (row as { providerKey: string | null }).providerKey = providerKey;
  }

  /** `prisma.job`. */
  readonly job = {
    findFirst: async (args: { where: { dedupKey?: string; status?: { in: string[] }; type?: string; subjectType?: string; subjectId?: string } }) =>
      this.rows.find((row) => this.matches(row, args.where)) ?? null,
    findMany: async (args: { where: Record<string, unknown> }) => this.rows.filter((row) => this.matchesMany(row, args.where)),
  };

  /** The worker pass: runs every runnable job to completion, as the platform's claim loop and terminal path do. */
  async drain(): Promise<void> {
    for (let guard = 0; guard < 1000; guard += 1) {
      const row = this.rows.find((r) => r.status === 'pending' && (r.scheduledFor === null || r.scheduledFor <= new Date()));
      if (!row) return;
      await this.run(row);
    }
  }

  private async run(row: StandInJob): Promise<void> {
    const handler = this.registry.get(row.type);
    const mutable = row as unknown as { status: string; attempts: number; lastError: string | null; scheduledFor: Date | null };
    mutable.status = 'running';
    mutable.attempts += 1;
    try {
      if (!handler) throw new Error(`No handler is registered for ${row.type}`);
      await handler.process(row);
      mutable.status = 'succeeded';
      this.settle(row);
    } catch (error) {
      if (error instanceof RateLimitError) {
        // A deferral: back to pending, the attempt is not charged.
        mutable.attempts -= 1;
        mutable.status = 'pending';
        mutable.scheduledFor = new Date(Date.now() + 60_000);
        void this.throttle;
        return;
      }
      mutable.lastError = error instanceof Error ? error.message : String(error);
      if (mutable.attempts >= (handler?.profile?.maxAttempts ?? 3)) {
        mutable.status = 'failed';
        this.settle(row);
      } else {
        mutable.status = 'pending';
      }
    }
  }

  private settle(row: StandInJob): void {
    this.events.emit(JOB_SETTLED_EVENT, {
      jobId: row.id,
      type: row.type,
      status: row.status,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      lastError: row.lastError,
      job: row,
    });
  }

  private matches(row: StandInJob, where: { dedupKey?: string; status?: { in: string[] }; type?: string; subjectType?: string; subjectId?: string }): boolean {
    return (
      (where.dedupKey === undefined || row.dedupKey === where.dedupKey) &&
      (where.status === undefined || where.status.in.includes(row.status)) &&
      (where.type === undefined || row.type === where.type)
    );
  }

  private matchesMany(row: StandInJob, where: Record<string, unknown>): boolean {
    const types = (where['type'] as { in: string[] }).in;
    const statuses = (where['status'] as { in: string[] }).in;
    if (!types.includes(row.type) || !statuses.includes(row.status)) return false;
    const exclude = where['id'] as { not: string } | undefined;
    if (exclude && row.id === exclude.not) return false;
    const or = where['OR'] as Array<{ subjectType?: string; subjectId?: { in: string[] }; payload?: { path: string[]; equals: unknown } }> | undefined;
    if (!or) return true;
    return or.some((clause) => {
      if (clause.subjectId) {
        return (
          row.subjectId !== null &&
          clause.subjectId.in.includes(row.subjectId) &&
          (clause.subjectType === undefined || row.subjectType === clause.subjectType)
        );
      }
      if (clause.payload) return (row.payload as Record<string, unknown> | null)?.[clause.payload.path[0]!] === clause.payload.equals;
      return false;
    });
  }
}

/** The platform pieces the jobs adapter takes. */
export function buildJobsStandIns(): {
  queue: StandInQueue;
  registry: JobHandlerRegistry;
  throttle: ProviderThrottleService;
  events: EventEmitter2;
  scope: { run: <R>(job: unknown, fn: (tx: unknown) => Promise<R>) => Promise<R> };
  defaultOrg: { get: () => Promise<string> };
} {
  const registry = new JobHandlerRegistry();
  const throttle = new ProviderThrottleService(new ConfigService({}));
  const events = new EventEmitter2();
  return {
    queue: new StandInQueue(registry, throttle, events),
    registry,
    throttle,
    events,
    scope: { run: (_job, fn) => fn({}) },
    defaultOrg: { get: async () => '00000000-0000-4000-8000-0000000000a0' },
  };
}

/** An in-memory platform `StorageProvider` (the driver the resolver would hand the object-store adapter). */
export class StandInStorageProvider implements StorageProvider {
  readonly objects = new Map<string, Buffer>();

  constructor(
    readonly kind = 'local',
    private readonly bucket = 'stand-in-bucket',
  ) {}

  async upload(key: string, stream: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this.objects.set(key, Buffer.concat(chunks));
    return { key, bucket: this.bucket, location: `stand-in://${this.bucket}/${key}` };
  }
  async initMultipartUpload(): Promise<never> {
    throw new Error('not used');
  }
  async getSignedUploadUrl(): Promise<never> {
    throw new Error('not used');
  }
  async completeMultipartUpload(): Promise<never> {
    throw new Error('not used');
  }
  async abortMultipartUpload(): Promise<void> {}
  async download(key: string): Promise<Readable> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`No such object: ${key}`);
    return Readable.from([bytes]);
  }
  async getSignedDownloadUrl(key: string, options?: { expiresIn?: number }): Promise<string> {
    return `stand-in://${this.bucket}/${key}?expires=${options?.expiresIn ?? 3600}`;
  }
  async getSignedPutUrl(key: string): Promise<string> {
    return `stand-in://${this.bucket}/${key}?put=1`;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async getMetadata(): Promise<Record<string, string> | null> {
    return null;
  }
  async setMetadata(): Promise<void> {}
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  getBucket(): string {
    return this.bucket;
  }
  async deleteMany(keys: readonly string[]) {
    for (const key of keys) this.objects.delete(key);
    return { deleted: [...keys], failed: [] };
  }
  async size(key: string): Promise<number | null> {
    return this.objects.get(key)?.byteLength ?? null;
  }
}
