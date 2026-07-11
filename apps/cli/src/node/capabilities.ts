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

// ---------------------------------------------------------------------------
// Node-eligible job types
// ---------------------------------------------------------------------------

export const NODE_JOB_TYPES = [
  'face_detection',
  'video_face_detection',
  'duplicate_detection',
  'metadata_extraction',
  'social_media_detection',
  'thumbnail_regen',
  'thumbnail_repair',
  'auto_tagging',
  'geocode',
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
  thumbnail_regen: ['sharp'],
  thumbnail_repair: ['sharp'],
  auto_tagging: ['sharp'],
  geocode: [],
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
 * side-effects) plus the ffmpeg/ffprobe binaries. Never throws — an
 * unavailable capability is reported with `available: false`.
 */
export async function detectCapabilities(): Promise<Record<string, CapabilityStatus>> {
  const result: Record<string, CapabilityStatus> = {};

  for (const [key, moduleSpecifier] of Object.entries(NATIVE_MODULES)) {
    const installed = isModuleInstalled(moduleSpecifier);
    result[key] = installed
      ? { available: true, detail: moduleSpecifier }
      : { available: false, detail: `${moduleSpecifier} not installed` };
  }

  const [ffmpeg, ffprobe] = await Promise.all([
    detectFfmpeg().catch(() => ({ available: false as const })),
    detectBinary('ffprobe'),
  ]);

  result['ffmpeg'] = ffmpeg.available
    ? { available: true, detail: 'ffmpeg on PATH' }
    : { available: false, detail: 'ffmpeg not found on PATH' };
  result['ffprobe'] = ffprobe.available
    ? { available: true, detail: 'ffprobe on PATH' }
    : { available: false, detail: 'ffprobe not found on PATH' };

  return result;
}

/**
 * Given a capability snapshot, return the required capability keys that are
 * missing for a job type. Empty array = fully supported.
 */
export function missingRequirements(
  jobType: NodeJobType,
  caps: Record<string, CapabilityStatus>,
): string[] {
  const required = JOB_TYPE_REQUIREMENTS[jobType] ?? [];
  return required.filter((cap) => !caps[cap]?.available);
}

// ---------------------------------------------------------------------------
// Compute dispatcher
// ---------------------------------------------------------------------------

/**
 * Per-job context the engine can (optionally) supply to a compute module —
 * currently used only by the thumbnail compute path, which needs the node's
 * own id and the claimed job's id to request a presigned upload URL via
 * `POST /api/nodes/:id/jobs/:jobId/upload-url` before it can return a result.
 *
 * TODO(daemon-agent): the running node engine (`node/node-engine.ts`, owned by
 * a concurrent daemon-focused change) currently calls
 * `dispatcher.compute(type, inputPath, params)` with no 4th argument — ctx is
 * always undefined until the engine is updated to pass
 * `{ nodeId: this.nodeId, jobId }` as documented here. Until that lands,
 * ctx-dependent compute paths (thumbnail) throw a clear error rather than
 * silently misbehaving; see node/compute/thumbnail.ts.
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
      thumbnail_repair: lazy(() => import('./compute/thumbnail.js'), 'thumbnail_repair'),
      auto_tagging: lazy(() => import('./compute/auto-tagging.js'), 'auto_tagging'),
      geocode: lazy(() => import('./compute/geocode.js'), 'geocode'),
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
