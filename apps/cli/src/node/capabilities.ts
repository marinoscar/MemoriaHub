/**
 * node/capabilities.ts — Worker-node capability detection + compute dispatch.
 *
 * A worker node advertises which enrichment job types it can process. Whether a
 * type is processable depends on the runtime availability of heavy native model
 * libraries (onnxruntime-node, sharp, TensorFlow, Human, tesseract.js) and the
 * ffmpeg/ffprobe binaries on PATH.
 *
 * CRITICAL: none of the native libraries are statically imported anywhere in the
 * CLI. They live in `optionalDependencies` and are loaded at RUNTIME via
 * `loadNativeModule` behind an `any` boundary, so the CLI typechecks and builds
 * cleanly even when the libraries are not installed. Presence is probed with
 * `require.resolve` (no module side-effects), and only the actual compute path
 * dynamically imports the library.
 */

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { detectFfmpeg } from '../convert/ffmpeg.js';

const requireResolve = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a capability required to process a job is unavailable at runtime —
 * either a native library is not installed or a compute path is not yet
 * implemented in the CLI. Carries the missing capability key for diagnostics.
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

// ---------------------------------------------------------------------------
// Native module registry
// ---------------------------------------------------------------------------

/** Capability key → npm module specifier for the native libraries. */
export const NATIVE_MODULES: Record<string, string> = {
  onnxruntime: 'onnxruntime-node',
  sharp: 'sharp',
  tfjs: '@tensorflow/tfjs',
  tfjsWasm: '@tensorflow/tfjs-backend-wasm',
  human: '@vladmandic/human',
  tesseract: 'tesseract.js',
};

/**
 * Dynamically load a native module by npm specifier, mapping a load failure to
 * a {@link CapabilityUnavailableError}. The specifier is passed through a
 * variable so `tsc` never attempts to statically resolve the (uninstalled)
 * module — this is what keeps typecheck green without the native libs present.
 */
export async function loadNativeModule(moduleSpecifier: string): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return await import(moduleSpecifier);
  } catch (err) {
    throw new CapabilityUnavailableError(
      `${moduleSpecifier} is not installed (add it to run this compute locally)`,
      moduleSpecifier,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** True when a module can be resolved without executing its top-level code. */
function isModuleInstalled(moduleSpecifier: string): boolean {
  try {
    requireResolve.resolve(moduleSpecifier);
    return true;
  } catch {
    return false;
  }
}

/** Probe whether a binary is runnable on PATH via `<bin> -version`. */
function detectBinary(bin: string): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ available: false });
        return;
      }
      const firstLine = String(stdout).split('\n', 1)[0]?.trim();
      resolve({ available: true, version: firstLine });
    });
  });
}

/** Default base URL of a locally-run compreface-core sidecar a node calls into. */
export const DEFAULT_COMPREFACE_URL = 'http://localhost:3000';

/** Bounded HTTP GET {baseUrl}/status probe — presence-only, never throws. */
async function probeCompreface(baseUrl: string): Promise<CapabilityStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/status`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        available: false,
        detail: `compreface-core not reachable at ${baseUrl}: HTTP ${res.status}`,
      };
    }
    return { available: true, detail: `compreface-core reachable at ${baseUrl}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, detail: `compreface-core not reachable at ${baseUrl}: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Node-eligible job types
// ---------------------------------------------------------------------------

// NOTE: `thumbnail_repair` is deliberately absent — it is a GLOBAL sweep job
// (mediaItemId: null, inputUrl: null) that scans the whole database for media
// items missing thumbnails, which a node cannot do; only the per-item
// `thumbnail_regen` type is node-runnable (same compute module server-side).
// `face_auto_archive_sweep` and `location_inference` sweeps are server-only
// for the same reason.
//
// `workflow_execute_batch` (issue #144) IS node-runnable: it needs no media
// bytes (inputUrl is null) and no models/native deps — the node runs a pure-JS
// pass over the frozen action list to declare per-item intended outcomes, and
// the API's persistNodeResult re-does all authoritative DB work server-side.
// The three workflow SWEEP/SQL types (`workflow_evaluate`,
// `workflow_evaluate_item`, `workflow_history_purge`) stay server-only.
export const NODE_JOB_TYPES = [
  'face_detection',
  'video_face_detection',
  'duplicate_detection',
  'metadata_extraction',
  'social_media_detection',
  'thumbnail_regen',
  'auto_tagging',
  'geocode',
  'workflow_execute_batch',
] as const;

export type NodeJobType = (typeof NODE_JOB_TYPES)[number];

/** True when `t` is a job type this node knows how to (attempt to) process. */
export function isNodeJobType(t: string): t is NodeJobType {
  return (NODE_JOB_TYPES as readonly string[]).includes(t);
}

/**
 * Capability keys REQUIRED to process each job type. Optional/degraded-mode
 * libraries (e.g. onnxruntime for CLIP, tesseract for OCR Tier-2) are omitted
 * so a node without them can still take the job in degraded mode — the doctor
 * only errors when a listed requirement is missing.
 */
export const JOB_TYPE_REQUIREMENTS: Record<NodeJobType, string[]> = {
  face_detection: ['sharp', 'human'],
  video_face_detection: ['sharp', 'human', 'ffmpeg'],
  duplicate_detection: ['sharp'], // onnxruntime optional → dHash degraded mode
  metadata_extraction: ['sharp'],
  social_media_detection: ['ffprobe'], // tesseract optional → Tier-1-only mode
  thumbnail_regen: ['sharp', 'ffmpeg'],
  auto_tagging: ['sharp'],
  geocode: [],
  // Pure-JS declaration pass — no native libs, no model files, no ffmpeg.
  workflow_execute_batch: [],
};

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

export interface CapabilityStatus {
  available: boolean;
  detail?: string;
}

/**
 * Runtime-probe every capability: each native library (presence only, no
 * side-effects) plus the ffmpeg/ffprobe binaries plus a bounded reachability
 * probe of a CompreFace core sidecar. Never throws — an unavailable
 * capability is reported with `available: false`.
 *
 * `opts.comprefaceUrl` overrides the probed URL; a node NOT using CompreFace
 * still runs this probe by default every time capabilities are detected, so
 * it is bounded (~3s) and never hangs the sweep.
 */
export async function detectCapabilities(opts?: {
  comprefaceUrl?: string;
}): Promise<Record<string, CapabilityStatus>> {
  const result: Record<string, CapabilityStatus> = {};

  for (const [key, moduleSpecifier] of Object.entries(NATIVE_MODULES)) {
    const installed = isModuleInstalled(moduleSpecifier);
    result[key] = installed
      ? { available: true, detail: moduleSpecifier }
      : { available: false, detail: `${moduleSpecifier} not installed` };
  }

  const [ffmpeg, ffprobe, compreface] = await Promise.all([
    detectFfmpeg().catch(() => ({ available: false as const })),
    detectBinary('ffprobe'),
    probeCompreface(opts?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL),
  ]);

  result['ffmpeg'] = ffmpeg.available
    ? { available: true, detail: 'ffmpeg on PATH' }
    : { available: false, detail: 'ffmpeg not found on PATH' };
  result['ffprobe'] = ffprobe.available
    ? { available: true, detail: 'ffprobe on PATH' }
    : { available: false, detail: 'ffprobe not found on PATH' };
  result['compreface'] = compreface;

  return result;
}

/**
 * Derive the effective capability requirements for a job type given the
 * node's configured face-detection provider. Identical to
 * `JOB_TYPE_REQUIREMENTS[jobType]` for every job type except
 * `face_detection`/`video_face_detection`, where the literal `'human'`
 * requirement is substituted for the configured provider. Pure derivation —
 * `JOB_TYPE_REQUIREMENTS` itself is never mutated and remains the source of
 * truth for the default (Human) case.
 */
export function effectiveRequirements(
  jobType: NodeJobType,
  faceProvider: 'human' | 'compreface' = 'human',
): string[] {
  const required = JOB_TYPE_REQUIREMENTS[jobType] ?? [];
  if (faceProvider === 'human') return required;
  if (jobType !== 'face_detection' && jobType !== 'video_face_detection') return required;
  return required.map((cap) => (cap === 'human' ? faceProvider : cap));
}

/**
 * Given a capability snapshot, return the required capability keys that are
 * missing for a job type. Empty array = fully supported. `faceProvider`
 * defaults to `'human'` so every existing 2-argument call site keeps
 * compiling and behaves identically to today.
 */
export function missingRequirements(
  jobType: NodeJobType,
  caps: Record<string, CapabilityStatus>,
  faceProvider: 'human' | 'compreface' = 'human',
): string[] {
  const required = effectiveRequirements(jobType, faceProvider);
  return required.filter((cap) => !caps[cap]?.available);
}

// ---------------------------------------------------------------------------
// Startup operational self-test evaluation (issue #148)
// ---------------------------------------------------------------------------

/** A required capability whose operational self-test failed for an eligible type. */
export interface StartupSelfTestBlocker {
  capability: string;
  jobType: NodeJobType;
  detail?: string;
}

/** An optional/degradable capability that failed its self-test but does not block. */
export interface StartupSelfTestDegrade {
  capability: string;
  detail?: string;
}

export interface StartupSelfTestEvaluation {
  /** True when no REQUIRED capability failed — safe to start the engine. */
  ok: boolean;
  blockingFailures: StartupSelfTestBlocker[];
  degraded: StartupSelfTestDegrade[];
}

/**
 * Decide whether a node may start given its startup operational self-test.
 *
 * Reuses `missingRequirements()` — the exact readiness logic `node doctor`
 * uses — against the OPERATIONAL snapshot (not mere presence), so a required
 * capability whose real decode/embed/detect self-test failed is a blocker,
 * while an optional/degradable one (e.g. tesseract for social_media_detection
 * Tier-2 OCR, onnxruntime for duplicate_detection's CLIP) is never listed as a
 * requirement and therefore only surfaces in `degraded`, never `blockingFailures`.
 *
 * Pure — no process side effects; the command layer owns the exit.
 */
export function evaluateStartupSelfTest(
  caps: Record<string, CapabilityStatus>,
  operationalResults: Record<string, CapabilityStatus>,
  eligibleTypes: string[],
  faceProvider: 'human' | 'compreface' = 'human',
): StartupSelfTestEvaluation {
  const types = eligibleTypes.filter(isNodeJobType);
  const blockingFailures: StartupSelfTestBlocker[] = [];
  const blockingCaps = new Set<string>();
  for (const t of types) {
    for (const cap of missingRequirements(t, operationalResults, faceProvider)) {
      blockingFailures.push({
        capability: cap,
        jobType: t,
        detail: operationalResults[cap]?.detail,
      });
      blockingCaps.add(cap);
    }
  }

  const degraded: StartupSelfTestDegrade[] = [];
  for (const [cap, presence] of Object.entries(caps)) {
    if (blockingCaps.has(cap)) continue;
    const op = operationalResults[cap];
    // Installed (presence ok) but its operational self-test did not pass, and it
    // is not a hard requirement of any eligible type → a non-fatal degrade.
    if (presence.available && op && !op.available) {
      degraded.push({ capability: cap, detail: op.detail });
    }
  }

  return { ok: blockingFailures.length === 0, blockingFailures, degraded };
}

// ---------------------------------------------------------------------------
// Heartbeat capability payload enrichment (issue #148)
// ---------------------------------------------------------------------------

/**
 * A capability status enriched with the STARTUP operational self-test outcome.
 * Backward-compatible superset of {@link CapabilityStatus}: the `operational*`
 * fields are optional and omitted for capabilities that were never
 * operationally tested (or are simply absent), so a payload without them is
 * exactly the pre-#148 presence-only shape an older API already tolerates.
 */
export interface OperationalCapabilityStatus extends CapabilityStatus {
  /** Result of the startup operational self-test; absent = not tested. */
  operational?: boolean;
  operationalDetail?: string;
}

/**
 * Merge a FRESH presence snapshot (probed every heartbeat) with the CACHED
 * startup operational self-test result, producing the heartbeat capability
 * payload. Presence stays live; the (expensive) operational result is only ever
 * computed once at startup and carried forward here.
 *
 * Only present capabilities carry an `operational` field — an absent capability
 * stays presence-only so the server can distinguish "operational self-test
 * failed" from "package not installed".
 */
export function mergeOperationalCapabilities(
  presence: Record<string, CapabilityStatus>,
  operational?: Record<string, CapabilityStatus>,
): Record<string, OperationalCapabilityStatus> {
  const out: Record<string, OperationalCapabilityStatus> = {};
  for (const [key, status] of Object.entries(presence)) {
    const op = status.available ? operational?.[key] : undefined;
    out[key] = op
      ? {
          ...status,
          operational: op.available,
          ...(op.detail ? { operationalDetail: op.detail } : {}),
        }
      : { ...status };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compute dispatcher
// ---------------------------------------------------------------------------

/**
 * Per-job context the engine supplies to a compute module — currently used
 * only by the thumbnail compute path, which needs the node's own id and the
 * claimed job's id to request a presigned upload URL via
 * `POST /api/nodes/:id/jobs/:jobId/upload-url` before it can return a result.
 * Populated by `NodeEngine.processJob` on every claim.
 */
export interface ComputeJobContext {
  nodeId: string;
  jobId: string;
}

/**
 * A per-type compute function: takes the local input path + resolved params,
 * plus an optional job context (nodeId/jobId) for compute paths that need to
 * call back into the API mid-compute (e.g. requesting a presigned upload URL).
 * The third parameter is additive — existing two-arg compute modules remain
 * valid ComputeFn implementations.
 */
export type ComputeFn = (
  inputPath: string,
  params: Record<string, unknown>,
  ctx?: ComputeJobContext,
) => Promise<unknown>;

/**
 * Routes a job type to its per-type compute module under `node/compute/`.
 *
 * The dispatcher is UI-agnostic and injectable so the node engine can be
 * unit-tested with a stub dispatcher. The real per-type modules currently
 * scaffold the interface (load the native lib, then throw
 * CapabilityUnavailableError "not yet implemented"); the model math lands with
 * the shared enrichment-compute parity package.
 */
export class ComputeDispatcher {
  private readonly routes: Record<NodeJobType, () => Promise<{ default: ComputeFn }>>;

  constructor(overrides?: Partial<Record<NodeJobType, ComputeFn>>) {
    // Lazy-import each compute module so a node only pays for what it runs.
    const lazy = (loader: () => Promise<{ default: ComputeFn }>, key: NodeJobType) =>
      overrides?.[key]
        ? () => Promise.resolve({ default: overrides[key] as ComputeFn })
        : loader;

    this.routes = {
      face_detection: lazy(() => import('./compute/face-detection.js'), 'face_detection'),
      video_face_detection: lazy(
        () => import('./compute/video-face-detection.js'),
        'video_face_detection',
      ),
      duplicate_detection: lazy(
        () => import('./compute/duplicate-detection.js'),
        'duplicate_detection',
      ),
      metadata_extraction: lazy(() => import('./compute/metadata.js'), 'metadata_extraction'),
      social_media_detection: lazy(
        () => import('./compute/social-media-detection.js'),
        'social_media_detection',
      ),
      thumbnail_regen: lazy(() => import('./compute/thumbnail.js'), 'thumbnail_regen'),
      auto_tagging: lazy(() => import('./compute/auto-tagging.js'), 'auto_tagging'),
      geocode: lazy(() => import('./compute/geocode.js'), 'geocode'),
      workflow_execute_batch: lazy(
        () => import('./compute/workflow-execute-batch.js'),
        'workflow_execute_batch',
      ),
    };
  }

  /**
   * Compute a job's result locally. Throws CapabilityUnavailableError when the
   * type is unknown or its compute path is unavailable/unimplemented.
   *
   * `ctx`, when supplied, is forwarded as the compute module's 3rd argument —
   * see {@link ComputeJobContext}. Optional and currently unpopulated by the
   * running engine (see the TODO on ComputeJobContext); ctx-dependent compute
   * paths handle `ctx === undefined` themselves.
   */
  async compute(
    jobType: string,
    inputPath: string,
    params: Record<string, unknown>,
    ctx?: ComputeJobContext,
  ): Promise<unknown> {
    if (!isNodeJobType(jobType)) {
      throw new CapabilityUnavailableError(
        `job type "${jobType}" is not supported by the CLI worker node`,
        jobType,
      );
    }
    const loader = this.routes[jobType];
    const mod = await loader();
    return mod.default(inputPath, params, ctx);
  }
}
