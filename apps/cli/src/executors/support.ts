/**
 * executors/support.ts - what the node compute modules share (RETRO-C10, #616).
 *
 * The compute modules (`./compute/*.ts`) hold MemoriaHub's per-type logic, unchanged from the
 * 1.3 worker. They used to receive `(inputPath, params, { nodeId, jobId })` from the app's own
 * engine and reach the API through a hand-built `ApiClient`. On the platform engine an executor
 * gets a `JobExecutionContext`; `computeContextOf` narrows it to the {@link ComputeJobContext}
 * the compute modules take, so they never see the whole engine and stay testable with a plain
 * object.
 */

import { createRequire } from 'node:module';

import type { ClaimToken, ExecutorNodeApi, JobExecutionContext } from '@marinoscar/platform-cli/node';

import { appWorkerEnv } from '../worker-env.js';

/**
 * Thrown when a capability a job needs is unavailable at runtime: a native library is not
 * installed, or no tool can do the work. Carries the missing capability key for diagnostics. A
 * plain `Error` to the engine, so the job is reported failed with this message.
 */
export class CapabilityUnavailableError extends Error {
  constructor(
    message: string,
    /** The capability/module key that was unavailable. */
    public readonly capability?: string,
    /** Underlying cause detail, when available. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'CapabilityUnavailableError';
  }
}

/** What a compute module may use of the claimed job. */
export interface ComputeJobContext {
  /** This node's id, for `api` calls. */
  nodeId: string;
  /** The claimed job's id, for `api` calls. */
  jobId: string;
  /** Which claim of the job is running; passed through to every `api` call. */
  claimToken: ClaimToken;
  /** Upload targets and brokered secrets of the held job. */
  api: ExecutorNodeApi;
  /** The input object's MIME type, when the job had an input object. */
  mimeType: string | undefined;
  /** Aborted on drain and lease loss. */
  signal: AbortSignal;
  /** Structured, redacting log. */
  log(message: string, fields?: Record<string, unknown>): void;
}

/**
 * A per-type compute function: the local input path (empty for a type with no input), the
 * job's payload and the job context. Returns the result the server's `nodeResultSchema` expects;
 * throws to fail the job.
 */
export type ComputeFn = (
  inputPath: string,
  params: Record<string, unknown>,
  ctx: ComputeJobContext,
) => Promise<unknown>;

/** Narrows the engine's context to what the compute modules take. */
export function computeContextOf(context: JobExecutionContext): ComputeJobContext {
  return {
    nodeId: context.nodeId,
    jobId: context.job.id,
    claimToken: context.claimToken,
    api: context.api,
    mimeType: context.input?.mimeType,
    signal: context.signal,
    log: context.log,
  };
}

/** The input path an executor with `input: 'download'` is guaranteed; named failure otherwise. */
export function requireInputPath(context: JobExecutionContext): string {
  if (context.inputPath === undefined || context.inputPath === '') {
    throw new Error(`job ${context.job.id} (${context.job.type}) has no input file`);
  }
  return context.inputPath;
}

/** Capability key to npm module specifier for the optional native libraries. */
export const NATIVE_MODULES: Readonly<Record<string, string>> = Object.freeze({
  onnxruntime: 'onnxruntime-node',
  sharp: 'sharp',
  tesseract: 'tesseract.js',
});

/**
 * Dynamically loads a native module by npm specifier, mapping a load failure to a
 * {@link CapabilityUnavailableError}. The specifier goes through a variable so `tsc` never
 * resolves the (optional) module statically.
 */
export async function loadNativeModule(moduleSpecifier: string): Promise<any> {
  try {
    return await import(moduleSpecifier);
  } catch (err) {
    throw new CapabilityUnavailableError(
      `${moduleSpecifier} is not installed (add it to run this compute locally)`,
      moduleSpecifier,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** True when a module resolves, without executing its top-level code. */
export function isModuleInstalled(moduleSpecifier: string): boolean {
  try {
    createRequire(import.meta.url).resolve(moduleSpecifier);
    return true;
  } catch {
    return false;
  }
}

/** Default base URL of a locally-run compreface-core sidecar a node calls into. */
export const DEFAULT_COMPREFACE_URL = 'http://localhost:3000';

/** The CompreFace base URL: `MEMORIAHUB_COMPREFACE_URL`, else the local default. */
export function comprefaceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[appWorkerEnv.comprefaceUrl]?.trim();
  return raw !== undefined && raw !== '' ? raw : DEFAULT_COMPREFACE_URL;
}

/**
 * PUTs `bytes` to a presigned URL the server issued. The URL is a bearer capability: it is never
 * logged and never part of an error message. Retries a throttle or a 5xx (S3 `503 SlowDown`, R2
 * `429`) a few times with a short backoff.
 */
export async function putToPresignedUrl(
  url: string,
  bytes: Buffer,
  contentType: string,
  options: { attempts?: number; backoffMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const attempts = options.attempts ?? 4;
  const backoffMs = options.backoffMs ?? 500;
  const doFetch = options.fetchImpl ?? fetch;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let status: number;
    try {
      const res = await doFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: bytes as unknown as BodyInit,
      });
      status = res.status;
      if (res.ok) return;
    } catch {
      status = 0;
    }
    lastStatus = status;
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
  }
  throw new Error(`output upload failed (HTTP ${lastStatus === 0 ? 'transport error' : lastStatus})`);
}
