import { randomUUID } from 'node:crypto';

import {
  MemoriahubRateLimitError,
  type MemoriahubActiveJob,
  type MemoriahubActiveJobQuery,
  type MemoriahubEnqueueInput,
  type MemoriahubEnqueueResult,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobSettledEvent,
  type MemoriahubJobsPort,
} from '../ports/index.js';

/**
 * One queued job of {@link FakeMemoriahubJobs}.
 *
 * @stability experimental
 */
export interface FakeMemoriahubJobRow extends MemoriahubJob {
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  skipDedup: boolean;
  scheduledFor: Date | null;
  lastError: string | null;
  deferrals: number;
}

/** The default attempt budget of a handler with no profile. */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * An in-memory `MEMORIAHUB_JOBS`: the dedup rule (one pending or running job per type and subject),
 * the registration refusals (an AI handler may not be node-eligible; the node pair is both or neither),
 * retries to the attempt budget, deferral on a {@link MemoriahubRateLimitError} and settled events.
 * `drain()` plays the worker.
 *
 * @stability experimental
 */
export class FakeMemoriahubJobs implements MemoriahubJobsPort {
  private readonly handlers = new Map<string, MemoriahubJobHandler>();

  private readonly rows: FakeMemoriahubJobRow[] = [];

  private readonly listeners: Array<(event: MemoriahubJobSettledEvent) => void> = [];

  /** Every job ever queued, oldest first (a read-only view for assertions). */
  get jobs(): ReadonlyArray<Readonly<FakeMemoriahubJobRow>> {
    return this.rows;
  }

  /** The handlers, by type. */
  get registered(): ReadonlyMap<string, MemoriahubJobHandler> {
    return this.handlers;
  }

  /**
   * Queues a job.
   *
   * @param input - what to run.
   */
  async enqueue(input: MemoriahubEnqueueInput): Promise<MemoriahubEnqueueResult> {
    return this.insert(input);
  }

  /**
   * Queues a job; the fake has no transaction to join, so this equals `enqueue`.
   *
   * @param _tx - the caller's transaction (ignored).
   * @param input - what to run.
   */
  async enqueueWithin(_tx: unknown, input: MemoriahubEnqueueInput): Promise<MemoriahubEnqueueResult> {
    return this.insert(input);
  }

  /**
   * Queues a housekeeping job unless one of the type is in flight.
   *
   * @param input - the type and a label.
   */
  async enqueueHousekeeping(input: { type: string; what: string }): Promise<{ id: string } | null> {
    const result = this.insert({ type: input.type, payload: {}, priority: 100, orgId: null, reason: 'backfill' });
    return result.deduplicated ? null : { id: result.id };
  }

  /**
   * Registers a handler.
   *
   * @param handler - the handler.
   */
  registerHandler(handler: MemoriahubJobHandler): void {
    if (handler.nodeResultSchema !== undefined && handler.usesAi === true) {
      throw new Error(`Job type "${handler.type}" calls a model and may not declare nodeResultSchema`);
    }
    if ((handler.nodeResultSchema === undefined) !== (handler.persistNodeResult === undefined)) {
      throw new Error(`Job type "${handler.type}" must declare nodeResultSchema and persistNodeResult together or neither`);
    }
    this.handlers.set(handler.type, handler);
  }

  /**
   * Whether a handler is registered.
   *
   * @param type - the job type.
   */
  isRegistered(type: string): boolean {
    return this.handlers.has(type);
  }

  /**
   * Listens for settled jobs.
   *
   * @param listener - called once for each settled job.
   */
  onSettled(listener: (event: MemoriahubJobSettledEvent) => void): void {
    this.listeners.push(listener);
  }

  /**
   * The pending or running jobs that match a query.
   *
   * @param query - the types and the subjects or payload values.
   */
  async findActive(query: MemoriahubActiveJobQuery): Promise<MemoriahubActiveJob[]> {
    const subjects = query.subjectIds && query.subjectIds.length > 0 ? new Set(query.subjectIds) : null;
    const values = query.payloadKey !== undefined && query.payloadValues ? new Set(query.payloadValues) : null;
    if (subjects === null && values === null && (query.subjectIds !== undefined || query.payloadValues !== undefined)) return [];

    return this.rows
      .filter((row) => (row.status === 'pending' || row.status === 'running') && query.types.includes(row.type))
      .filter((row) => query.excludeJobId === undefined || row.id !== query.excludeJobId)
      .filter((row) => {
        if (subjects === null && values === null) return true;
        const bySubject =
          subjects !== null &&
          row.subjectId !== null &&
          subjects.has(row.subjectId) &&
          (query.subjectType === undefined || row.subjectType === query.subjectType);
        const payload = row.payload as Record<string, unknown> | null;
        const byValue = values !== null && query.payloadKey !== undefined && values.has(String(payload?.[query.payloadKey]));
        return bySubject || byValue;
      })
      .map((row) => ({ id: row.id, type: row.type, subjectType: row.subjectType, subjectId: row.subjectId, payload: row.payload }));
  }

  /**
   * Runs a unit of work "in the job's organization": the fake passes an empty transaction client.
   *
   * @param _job - the job.
   * @param fn - the work.
   */
  async runInJobScope<R>(_job: Pick<MemoriahubJob, 'id' | 'orgId'>, fn: (tx: any) => Promise<R>): Promise<R> {
    return fn({});
  }

  /**
   * A scratch-file path.
   *
   * @param suffix - a file extension.
   */
  tempPath(suffix = ''): string {
    return `/tmp/memoriahub-fake-${randomUUID()}${suffix}`;
  }

  /**
   * Plays the worker: runs every runnable job until none is left, honouring attempts, deferrals and
   * the node-eligibility rules. Emits one settled event per terminal job.
   */
  async drain(): Promise<void> {
    for (let guard = 0; guard < 1000; guard += 1) {
      const row = this.rows.find((r) => r.status === 'pending' && (r.scheduledFor === null || r.scheduledFor <= new Date()));
      if (!row) return;
      await this.run(row);
    }
  }

  private insert(input: MemoriahubEnqueueInput): MemoriahubEnqueueResult {
    if (input.skipDedup !== true) {
      const existing = this.rows.find(
        (row) =>
          (row.status === 'pending' || row.status === 'running') &&
          !row.skipDedup &&
          row.type === input.type &&
          row.subjectType === (input.subjectType ?? null) &&
          row.subjectId === (input.subjectId ?? null),
      );
      if (existing) return { id: existing.id, deduplicated: true };
    }

    const row: FakeMemoriahubJobRow = {
      id: randomUUID(),
      type: input.type,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      payload: input.payload,
      attempts: 0,
      orgId: input.orgId ?? null,
      status: 'pending',
      skipDedup: input.skipDedup === true,
      scheduledFor: input.scheduledFor ?? null,
      lastError: null,
      deferrals: 0,
    };
    this.rows.push(row);
    return { id: row.id, deduplicated: false };
  }

  private async run(row: FakeMemoriahubJobRow): Promise<void> {
    const handler = this.handlers.get(row.type);
    if (!handler) {
      row.status = 'failed';
      row.lastError = `No handler is registered for ${row.type}`;
      this.settle(row);
      return;
    }

    row.status = 'running';
    row.attempts += 1;
    try {
      await handler.process({ id: row.id, type: row.type, subjectType: row.subjectType, subjectId: row.subjectId, payload: row.payload, attempts: row.attempts, orgId: row.orgId });
      row.status = 'succeeded';
      this.settle(row);
    } catch (error) {
      if (error instanceof MemoriahubRateLimitError) {
        // A deferral: back to pending, the attempt is not charged.
        row.attempts -= 1;
        row.deferrals += 1;
        row.status = 'pending';
        row.scheduledFor = new Date(Date.now() + 60_000);
        return;
      }
      row.lastError = error instanceof Error ? error.message : String(error);
      const budget = handler.profile?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      if (row.attempts >= budget) {
        row.status = 'failed';
        this.settle(row);
      } else {
        row.status = 'pending';
      }
    }
  }

  private settle(row: FakeMemoriahubJobRow): void {
    const event: MemoriahubJobSettledEvent = {
      jobId: row.id,
      type: row.type,
      status: row.status === 'succeeded' ? 'succeeded' : 'failed',
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      payload: row.payload,
      lastError: row.lastError,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener is a bystander: its failure is not the queue's.
      }
    }
  }
}
