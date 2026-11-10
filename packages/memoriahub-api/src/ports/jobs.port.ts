import type { z } from 'zod';

// =============================================================================
// MEMORIAHUB_JOBS: the background-job port (RETRO-J4, #610)
// =============================================================================
//
// Anything that outlives the request or cron tick that started it is a registered
// handler run through this port (the queue rule: no long-running work outside the
// queue). The web edition binds it over the platform queue (leases, dedup, worker
// nodes); a bare host binds an in-process queue.
//
// A JOB `type` STRING IS PERMANENT once a job of that type exists: a queued row
// names its handler by that string. `MemoriahubJobHandler` has NO field the platform
// handler lacks; `profile` carries exactly `maxRuntimeMs` and `maxAttempts` (never a
// lease or a heartbeat), and node eligibility is DERIVED from the presence of
// `nodeResultSchema` plus `persistNodeResult` (never a flag).
//
// AI JOBS ARE SERVER-ONLY, PERMANENTLY: a handler that calls a model declares
// `usesAi: true` and never declares the node pair; the binding refuses the
// combination at registration.
// =============================================================================

/**
 * Injection token of {@link MemoriahubJobsPort}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_JOBS = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_JOBS');

/**
 * The job a handler is given.
 *
 * @stability experimental
 */
export interface MemoriahubJob<P = unknown> {
  /** The job id. */
  id: string;
  /** The handler type. */
  type: string;
  /** The kind of thing the job is about, or `null`. */
  subjectType: string | null;
  /** Which one, or `null`. */
  subjectId: string | null;
  /** The input the enqueuer gave. */
  payload: P;
  /** Attempts so far, this one included. */
  attempts: number;
  /** The organization the job belongs to, or `null` for a system job. */
  orgId: string | null;
  /** The row's status (`pending`, `running`, `succeeded`, `failed`, ...), when the host tells. A `canDelete` veto reads it. */
  status?: string;
}

/**
 * How long a handler may run and how often it is tried.
 *
 * @stability experimental
 */
export interface MemoriahubJobProfile {
  /** The longest one attempt may run, in milliseconds. Lease and renewal derive from it. */
  maxRuntimeMs: number;
  /** How many attempts a job gets in total. */
  maxAttempts: number;
}

/**
 * Whether a node may be handed a per-job credential right now.
 *
 * @stability experimental
 */
export type MemoriahubJobSecretUsability = { ok: true } | { ok: false; reason: string; remedy: string };

/**
 * A credential issued to ONE job on a worker node. The material is serialised into one
 * HTTP response and dropped; only the handle is ever persisted.
 *
 * @stability experimental
 */
export interface MemoriahubIssuedJobSecret {
  /** What is stored to revoke it later; never the material. */
  readonly handle: string;
  /** When the credential stops being valid. */
  readonly expiresAt: Date;
  /** The credential itself, held in node memory only. */
  readonly material: Record<string, unknown>;
}

/**
 * The descriptor of a per-job credential a node-eligible type needs (a geocoding key).
 *
 * @stability experimental
 */
export interface MemoriahubJobSecretBroker {
  /** A short name for the kind of credential (`geocode.google`). */
  readonly kind: string;

  /** Whether this deployment may hand the credential to a node right now. */
  usable(): Promise<MemoriahubJobSecretUsability>;

  /**
   * Mints the credential for one job.
   *
   * @param job - the job the credential is for.
   * @param until - the latest expiry (the job's lease).
   */
  issue(job: MemoriahubJob, until: Date): Promise<MemoriahubIssuedJobSecret>;

  /**
   * Revokes a credential when its job settles.
   *
   * @param handle - the handle `issue` returned.
   */
  revoke(handle: string): Promise<void>;
}

/**
 * A handler for one job type.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubJobHandler<P = unknown> {
  /** The job type this handler runs. Permanent once jobs of it exist. */
  readonly type: string;
  /** A short sentence-case label for the admin job list. */
  readonly label?: string;
  /** The execution profile, or the host default when absent. */
  readonly profile?: MemoriahubJobProfile;
  /**
   * True when the handler calls a model. The binding refuses to register an AI handler
   * that is also node-eligible: AI work spends a key a node must never hold.
   */
  readonly usesAi?: boolean;
  /**
   * The provider throttle bucket every job of this type draws on. Registered with the
   * host's throttle when the handler is registered, so the queue holds claims back while
   * the bucket cools down.
   */
  readonly throttleKey?: string;
  /** The schema of the result a worker node returns; present with `persistNodeResult`. */
  readonly nodeResultSchema?: z.ZodType;
  /** The per-job credential a node of this type needs, when it needs one. */
  readonly nodeSecretBroker?: MemoriahubJobSecretBroker;

  /**
   * Runs one attempt. Throwing fails the attempt; throwing {@link MemoriahubRateLimitError}
   * defers it without charging an attempt.
   *
   * @param job - the job.
   */
  process(job: MemoriahubJob<P>): Promise<void>;

  /**
   * Stores the result a worker node computed. A handler with both this and
   * `nodeResultSchema` may run on a node; persist only, never recompute.
   *
   * @param job - the job.
   * @param result - the validated node result.
   */
  persistNodeResult?(job: MemoriahubJob<P>, result: unknown): Promise<void>;

  /**
   * Where a worker node's output upload lands (the object-store key). Idempotent per job.
   *
   * @param job - the job.
   */
  deriveOutputKey?(job: MemoriahubJob<P>): Promise<string>;

  /** A deployment's runtime switch for offering this type to worker nodes; absent means yes. */
  nodeOffloadEnabled?(): Promise<boolean>;

  /**
   * Vetoes an administrator's delete of a not-yet-settled row of this type.
   *
   * @param job - the row.
   * @returns a sentence telling the operator what to do instead, or `null` to allow.
   */
  canDelete?(job: MemoriahubJob<P>): Promise<string | null>;
}

/**
 * What to enqueue.
 *
 * @stability experimental
 */
export interface MemoriahubEnqueueInput {
  /** The handler type. */
  type: string;
  /** Why the job exists (`upload`, `rerun`, `backfill`, or a reason the host registered); the host default when absent. */
  reason?: string;
  /** The kind of thing the job is about. */
  subjectType?: string;
  /** Which one. Two pending jobs with the same type and subject collapse into one. */
  subjectId?: string;
  /** The handler input. Carry identifiers, not copies of data. */
  payload: Record<string, unknown>;
  /** Ascending is more urgent (0 beats a cron's 100). */
  priority?: number;
  /** Earliest time the job may run. */
  scheduledFor?: Date;
  /** Opt out of dedup: the job is distinct work. */
  skipDedup?: boolean;
  /** The organization the job belongs to; `null` for a system job; the host default when absent. */
  orgId?: string | null;
  /** The provider throttle bucket the work draws on. */
  throttleKey?: string;
}

/**
 * What `enqueue` returns.
 *
 * @stability experimental
 */
export interface MemoriahubEnqueueResult {
  /** The job's id: the new one, or the existing one the call collapsed into. */
  id: string;
  /** True when the call collapsed into a job already in flight. */
  deduplicated: boolean;
}

/**
 * What a settled job reports to {@link MemoriahubJobsPort.onSettled} listeners.
 *
 * @stability experimental
 */
export interface MemoriahubJobSettledEvent {
  /** The job id. */
  jobId: string;
  /** The handler type. */
  type: string;
  /** How it ended: `failed` is terminal (attempts exhausted), never a retry. */
  status: 'succeeded' | 'failed';
  /** The kind of thing the job was about, or `null`. */
  subjectType: string | null;
  /** Which one, or `null`. */
  subjectId: string | null;
  /** The input the enqueuer gave. */
  payload: unknown;
  /** The last error message of a failed job, or `null`. */
  lastError: string | null;
}

/**
 * Which not-yet-settled jobs {@link MemoriahubJobsPort.findActive} looks for. A job matches
 * when its type is listed and it is about one of the named subjects OR carries one of the
 * named payload values.
 *
 * @stability experimental
 */
export interface MemoriahubActiveJobQuery {
  /** The handler types to look at. */
  types: readonly string[];
  /** The subject kind to match, together with `subjectIds`. */
  subjectType?: string;
  /** The subject ids to match. */
  subjectIds?: readonly string[];
  /** A top-level payload key to match, together with `payloadValues`. */
  payloadKey?: string;
  /** The payload values to match. */
  payloadValues?: readonly string[];
  /** A job to leave out (the one asking). */
  excludeJobId?: string;
}

/**
 * A pending or running job, as {@link MemoriahubJobsPort.findActive} reports it.
 *
 * @stability experimental
 */
export interface MemoriahubActiveJob {
  /** The job id. */
  id: string;
  /** The handler type. */
  type: string;
  /** The subject kind, or `null`. */
  subjectType: string | null;
  /** The subject id, or `null`. */
  subjectId: string | null;
  /** The input the enqueuer gave. */
  payload: unknown;
}

/**
 * The job port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubJobsPort {
  /**
   * Queues a job, collapsing into the pending or running one of the same type and subject
   * unless `skipDedup` is set.
   *
   * @param input - what to run.
   * @returns the job id, and whether this call collapsed into an existing job.
   */
  enqueue(input: MemoriahubEnqueueInput): Promise<MemoriahubEnqueueResult>;

  /**
   * Queues a job INSIDE a database transaction the caller has open, so the row the job is
   * about and the job commit together or not at all.
   *
   * @param tx - the client a `$transaction(async (tx) => ...)` or `runInOrg` callback was given.
   * @param input - what to run.
   */
  enqueueWithin(tx: unknown, input: MemoriahubEnqueueInput): Promise<MemoriahubEnqueueResult>;

  /**
   * What a `@Cron` body does: decide the work is due, then enqueue a global housekeeping job
   * (priority 100, `orgId: null`) unless one of that type is already pending or running.
   *
   * @param input - the handler type and a few words naming the work for the log.
   * @returns the job id, or `null` when one is already in flight.
   */
  enqueueHousekeeping(input: { type: string; what: string }): Promise<{ id: string } | null>;

  /**
   * Registers the handler for a type. Call once per type, at start-up.
   *
   * @param handler - the handler.
   * @throws Error when the host refuses it (an AI handler declared node-eligible, or only one half of the node pair).
   */
  registerHandler(handler: MemoriahubJobHandler): void;

  /**
   * Whether a handler is registered for the type.
   *
   * @param type - the job type.
   */
  isRegistered(type: string): boolean;

  /**
   * Listens for jobs that reached a terminal state. The listener is a bystander: it must not
   * do work inline, and a throw is logged, never propagated.
   *
   * @param listener - called once for each settled job.
   */
  onSettled(listener: (event: MemoriahubJobSettledEvent) => void): void;

  /**
   * The pending or running jobs that match a query: the answer to "is anything still about
   * to touch this subject?".
   *
   * @param query - the types, and the subjects or payload values to look for.
   */
  findActive(query: MemoriahubActiveJobQuery): Promise<MemoriahubActiveJob[]>;

  /**
   * Runs a unit of work for a job in the job's organization (row-level security scope): the
   * job's `orgId`, or the host's default organization for a system job.
   *
   * @param job - the job (its id and `orgId`).
   * @param fn - receives the transaction client.
   */
  runInJobScope<R>(job: Pick<MemoriahubJob, 'id' | 'orgId'>, fn: (tx: any) => Promise<R>): Promise<R>;

  /**
   * A fresh path for a scratch file the host sweeps if the process dies before the handler
   * removes it. The caller creates and deletes the file.
   *
   * @param suffix - a file extension such as `.mp4`.
   */
  tempPath(suffix?: string): string;
}

/**
 * The well-known key under which an error answers "am I a provider rate limit?" for a queue
 * that classifies thrown values. A `Symbol.for` key, so a host recognises it without importing
 * this package.
 *
 * @stability experimental
 */
export const MEMORIAHUB_CLASSIFY_RATE_LIMIT: unique symbol = Symbol.for('jobs.classifyRateLimit');

/**
 * What a rate-limit error says about itself to a queue that asks.
 *
 * @stability experimental
 */
export interface MemoriahubRateLimitClassification {
  /** Always true: this error is a provider rate limit. */
  rateLimited: true;
  /** The provider's retry hint in milliseconds, or `null` when it gave none. */
  retryAfterMs: number | null;
}

/**
 * Thrown by a handler when a provider's rate limit was hit. The queue defers the job without
 * charging an attempt.
 *
 * @stability experimental
 */
export class MemoriahubRateLimitError extends Error {
  /** The throttle bucket that was limited. */
  readonly throttleKey: string;

  /** The provider's retry hint, in milliseconds, when it gave one. */
  readonly retryAfterMs?: number;

  /**
   * @param throttleKey - the bucket that was limited.
   * @param retryAfterMs - the provider's retry hint.
   * @param message - what to say in the job's last error; defaults to naming the bucket.
   */
  constructor(throttleKey: string, retryAfterMs?: number, message?: string) {
    super(message ?? `Rate limited on ${throttleKey}`);
    this.name = 'MemoriahubRateLimitError';
    this.throttleKey = throttleKey;
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Answers a queue's self-classification question: this is a rate limit, with the hint.
   *
   * @returns the verdict.
   */
  [MEMORIAHUB_CLASSIFY_RATE_LIMIT](): MemoriahubRateLimitClassification {
    return { rateLimited: true, retryAfterMs: this.retryAfterMs ?? null };
  }
}
