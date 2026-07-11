/**
 * Human face-detection pipeline (moved VERBATIM from
 * apps/api/src/face/providers/human.provider.ts).
 *
 * This module holds ONLY the pure compute half of the `human` face provider:
 * the Human config builder, the fs-backed IOHandler, the faceres embedding
 * patch, buffer→tensor decode, detection, and embedding L2-normalization.
 * Env-var reads (FACE_HUMAN_MODEL_PATH), credential plumbing, NestJS DI, and
 * the FaceProvider interface adapter all stay in the host (the API's
 * HumanProvider, or the CLI worker's face handler). The package never reads
 * env vars — `modelBasePath` is an explicit parameter.
 *
 * Parity contract (docs/specs/distributed-nodes.md §7): a face embedding
 * computed on a worker node must be numerically identical to one produced on
 * the server for the same bytes — same sharp decode, same Human/tfjs versions
 * (exact-pinned optionalDependencies), same faceres output patch, same
 * L2-normalization (shared with /clip).
 *
 * Heavy deps (@tensorflow/tfjs, @tensorflow/tfjs-backend-wasm,
 * @vladmandic/human) are optionalDependencies loaded LAZILY via nodeRequire
 * at createFaceDetector() time, so importing this subpath never crashes on a
 * lean install; a descriptive Error is thrown only when detection is
 * actually requested.
 *
 * =============================================================================
 * Runtime quirks handled here (Alpine/WASM-only environment) — preserved
 * bit-for-bit from the original provider:
 *
 * 1. file:// IOHandler: Node's global fetch (undici) does NOT support the
 *    file:// scheme.  @tensorflow/tfjs-node ships a native file:// handler but
 *    requires glibc and cannot be installed on Alpine/musl.  We register a
 *    custom fs-backed IOHandler on Human's OWN bundled tf instance (h.tf) so
 *    that Human can read model weights from disk.  Registering on the umbrella
 *    @tensorflow/tfjs package has no effect — Human uses its own bundled copy.
 *
 * 2. faceres embedding output: The faceres.json model's graph only declares
 *    two output nodes: gender_pred/Sigmoid [1,1] and age_pred/Softmax [1,100].
 *    The 1024-d face embedding lives at the intermediate node
 *    'global_pooling/Mean' which feeds the downstream dense layer but is never
 *    wired as a declared output.  Human's description predictor (I5) scans
 *    execute() outputs for a tensor with shape[1]===1024 and falls back to []
 *    when none is found (producing EMBEDDING_LEN: 0).  After h.load() we
 *    patch the GraphModelExecutor._outputs array to include the embedding node,
 *    so execute() returns the full triple [gender, age-bins, embedding].
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { nodeRequire, nodeResolve } from '../node-require.cjs';
import { l2Normalize } from '../clip/index.js';

/** modelVersion tag persisted with every Face row produced by this pipeline. */
export const FACE_MODEL_VERSION = 'human-faceres-1024';
export const FACE_PROVIDER_KEY = 'human';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FaceResult {
  box: [number, number, number, number];
  faceScore?: number;
  boxScore?: number;
  score?: number;
  embedding?: Float32Array | number[];
}

interface HumanResult {
  face?: FaceResult[];
}

// HumanInstance is the public API surface we use from the WASM build.
// h.tf is Human's own bundled TF instance (separate from the umbrella tfjs).
// All fields are optional so unit-test mocks that omit them compile and run.
export interface HumanInstance {
  // Human's own bundled TF io registry — separate from the umbrella tfjs.
  tf?: {
    io?: {
      registerLoadRouter?: (
        router: (url: unknown) => { load(): Promise<unknown> } | null,
      ) => void;
    };
  };
  // Loaded model map populated by h.load().
  models?: {
    models?: {
      faceres?: {
        executor?: {
          _outputs: Array<{ name: string }>;
          graph?: { nodes?: Record<string, { name: string }> };
        };
      };
    };
  };
  load(): Promise<void>;
  warmup(): Promise<void>;
  detect(input: unknown): Promise<HumanResult>;
}

/**
 * A detected face in PIXEL coordinates relative to the input image — exactly
 * what Human returns. Normalization to 0–1 fractions is the HOST's job (it
 * happens in the API's HumanProvider adapter, same place it always did).
 */
export interface ComputeDetectedFace {
  boundingBox: { x: number; y: number; width: number; height: number };
  /** Detection confidence, 0–1 scale. */
  confidence?: number;
  /** L2-normalized 1024-d embedding from the patched faceres output. */
  embedding?: number[];
}

/**
 * Result of FaceDetector.detect. `width`/`height` are the decoded input
 * dimensions from the SAME sharp decode that produced the tensor, so the
 * host normalizes bounding boxes against exactly the dimensions Human saw.
 */
export interface FaceDetectOutput {
  width: number;
  height: number;
  faces: ComputeDetectedFace[];
}

export interface FaceDetector {
  detect(image: Buffer): Promise<FaceDetectOutput>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function resolveWasmPath(): string {
  try {
    const pkgPath = nodeResolve('@tensorflow/tfjs-backend-wasm/package.json');
    return path.join(path.dirname(pkgPath), 'dist') + path.sep;
  } catch {
    // Fallback for environments where the package isn't installed locally
    return path.join('node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist') + path.sep;
  }
}

/**
 * Build the Human configuration for the faceres detection pipeline.
 *
 * `modelBasePath` is the directory containing blazeface-back.json/.bin and
 * faceres.json/.bin — an explicit PARAMETER (the API resolves it from
 * FACE_HUMAN_MODEL_PATH; the CLI from its models dir). No env reads here.
 */
export function humanConfig(modelBasePath: string): Record<string, unknown> {
  return {
    backend: 'wasm',
    wasmPath: resolveWasmPath(),
    modelBasePath: `file://${modelBasePath}/`,
    cacheSensitivity: 0,
    face: {
      enabled: true,
      detector: { enabled: true, modelPath: 'blazeface-back.json', rotation: false },
      mesh: { enabled: false },
      iris: { enabled: false },
      description: { enabled: true, modelPath: 'faceres.json' },
      emotion: { enabled: false },
      antispoof: { enabled: false },
      liveness: { enabled: false },
      age: { enabled: false },
      gender: { enabled: false },
      embedding: { enabled: false },
    },
    body: { enabled: false },
    hand: { enabled: false },
    gesture: { enabled: false },
    object: { enabled: false },
    segmentation: { enabled: false },
  };
}

// ---------------------------------------------------------------------------
// fs-backed IOHandler
//
// Registered on h.tf (Human's own TF instance) BEFORE h.load() so that every
// tf.loadGraphModel('file://…') call inside Human reads weights from disk
// instead of attempting a fetch (which undici does not support for file://).
//
// Why not use the umbrella @tensorflow/tfjs?  Human bundles its own TF copy
// internally; any router registered on the umbrella package's io registry is
// invisible to Human's model loader.
// ---------------------------------------------------------------------------

export function fileSystemIOHandler(url: string): { load(): Promise<unknown> } {
  return {
    load: async () => {
      // Strip the file:// prefix to obtain the absolute filesystem path
      const jsonPath = url.replace(/^file:\/\//, '');

      const modelJSON = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
        modelTopology: unknown;
        weightsManifest?: Array<{ weights?: unknown[]; paths?: string[] }>;
        format?: string;
        generatedBy?: string;
        convertedBy?: string;
        weightData?: ArrayBuffer;
        weightSpecs?: unknown[];
      };
      const modelDir = path.dirname(jsonPath);

      const { modelTopology, weightsManifest, format, generatedBy, convertedBy } = modelJSON;

      // If the model already has inline weightData (rare), return it as-is
      if (modelJSON.weightData) {
        return {
          modelTopology,
          weightSpecs: modelJSON.weightSpecs ?? [],
          weightData: modelJSON.weightData,
          format,
          generatedBy,
          convertedBy,
        };
      }

      // Read weight shards from disk and concatenate into one ArrayBuffer
      const weightSpecs: unknown[] = [];
      const buffers: Buffer[] = [];

      for (const group of (weightsManifest ?? [])) {
        weightSpecs.push(...(group.weights ?? []));
        for (const relPath of (group.paths ?? [])) {
          buffers.push(fs.readFileSync(path.join(modelDir, relPath)));
        }
      }

      const combined = Buffer.concat(buffers);
      // Slice to get a clean ArrayBuffer (avoids shared-backing-store issues
      // that can arise when Buffer.buffer has a non-zero byteOffset)
      const weightData = combined.buffer.slice(
        combined.byteOffset,
        combined.byteOffset + combined.byteLength,
      );

      return { modelTopology, weightSpecs, weightData, format, generatedBy, convertedBy };
    },
  };
}

// ---------------------------------------------------------------------------
// Patch faceres GraphModel to expose the 1024-d face embedding as an output.
//
// Background: the faceres.json model only declares two output nodes in its
// graph topology — gender_pred/Sigmoid [1,1] and age_pred/Softmax [1,100].
// The 1024-d face descriptor lives at 'global_pooling/Mean' (a Mean-pool over
// the final conv layer) which feeds the downstream dense projection but is
// never listed as a graph output.
//
// When Human calls w0.execute(faceTensor), tfjs's GraphModel executor returns
// only the declared outputs.  Human's I5() then does:
//   const P = m.find(B => B.shape[1] === 1024)
// and falls back to [] if none found — producing EMBEDDING_LEN: 0.
//
// Fix: push the embedding graph node into executor._outputs after h.load()
// so that execute() returns a third tensor [1,1024] that Human picks up.
// ---------------------------------------------------------------------------

export function patchFaceresEmbeddingOutput(h: HumanInstance): void {
  const faceres = h.models?.models?.faceres;
  if (!faceres?.executor) return; // guard: model not loaded or structure changed

  const executor = faceres.executor;
  const embNode = executor.graph?.nodes?.['global_pooling/Mean'];
  if (!embNode) return; // node absent in a future model revision — skip silently

  const alreadyPatched = executor._outputs.some((n) => n.name === 'global_pooling/Mean');
  if (!alreadyPatched) {
    executor._outputs.push(embNode);
  }
}

// ---------------------------------------------------------------------------
// Lazy heavy-dep loading
//
// The umbrella tfjs, the WASM backend, and Human are loaded on first
// createFaceDetector()/bufferToTensor() call — never at import time — so a
// lean install (no optionalDependencies) can still import this subpath.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let heavyDeps: { tf: any; HumanClass: new (config: unknown) => HumanInstance } | null = null;

function loadHeavyDeps(): { tf: any; HumanClass: new (config: unknown) => HumanInstance } {
  if (heavyDeps) return heavyDeps;

  let tf: any;
  try {
    tf = nodeRequire('@tensorflow/tfjs');
    nodeRequire('@tensorflow/tfjs-backend-wasm');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      'Face detection compute requires the optional dependencies @tensorflow/tfjs and ' +
        `@tensorflow/tfjs-backend-wasm, which are not installed: ${msg}`,
    );
  }

  // Load Human from the WASM build. The package's "node" export condition maps
  // to dist/human.node.js, which hard-requires @tensorflow/tfjs-node — a native
  // glibc binary unavailable on Alpine (musl). The package's dist/* subpath
  // keys in `exports` lack the required leading "./", so a bare
  // `require('@vladmandic/human/dist/human.node-wasm.js')` fails at module load
  // with ERR_PACKAGE_PATH_NOT_EXPORTED. We therefore resolve the package main
  // to its absolute dist dir and require the node-wasm build by ABSOLUTE path,
  // which bypasses the exports map and loads the pure-JS + WASM build (no
  // tfjs-node; runs on any libc).
  let humanWasmModule: any;
  try {
    const humanPkgMain = nodeResolve('@vladmandic/human');
    const humanWasmPath = path.join(path.dirname(humanPkgMain), 'human.node-wasm.js');
    humanWasmModule = nodeRequire(humanWasmPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Face detection compute requires the optional dependency @vladmandic/human, which is not installed: ${msg}`,
    );
  }

  // node-wasm exports Human as a named export; fall back through .default chain
  // for forward compatibility.
  const HumanClass: new (config: unknown) => HumanInstance =
    humanWasmModule.Human ?? humanWasmModule.default?.Human ?? humanWasmModule.default ?? humanWasmModule;

  heavyDeps = { tf, HumanClass };
  return heavyDeps;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode an image buffer to raw RGBA via sharp and wrap it as a tf.Tensor3D.
 * NOTE: no orientation handling here — callers hand in the PREPARED image
 * (prepareImageForProcessing output), matching the original provider flow.
 */
export async function bufferToTensor(
  image: Buffer,
): Promise<{ tensor: unknown; width: number; height: number }> {
  const { tf } = loadHeavyDeps();
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 4]) as { dispose(): void };
  return { tensor, width: info.width, height: info.height };
}

// ---------------------------------------------------------------------------
// Detector factory (lazy singleton per modelBasePath)
// ---------------------------------------------------------------------------

const detectorPromises = new Map<string, Promise<FaceDetector>>();

async function initDetector(modelBasePath: string): Promise<FaceDetector> {
  const { tf, HumanClass } = loadHeavyDeps();

  // Prime the umbrella tf backend (belt-and-suspenders; Human's own tf
  // initialises itself, but this keeps the umbrella instance consistent).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  await tf.setBackend('wasm');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  await tf.ready();

  const h: HumanInstance = new HumanClass(humanConfig(modelBasePath));

  // Register the fs IOHandler on Human's OWN bundled tf instance BEFORE
  // h.load().  Optional chaining guards against mock/stub environments
  // (unit tests) where h.tf is not present on the mock object.
  h.tf?.io?.registerLoadRouter?.((url: unknown) => {
    if (typeof url === 'string' && url.startsWith('file://')) {
      return fileSystemIOHandler(url);
    }
    return null;
  });

  await h.load();

  // After models are loaded, expose the 1024-d face embedding as a model
  // output.  See patchFaceresEmbeddingOutput for the full explanation.
  patchFaceresEmbeddingOutput(h);

  await h.warmup();

  return {
    async detect(image: Buffer): Promise<FaceDetectOutput> {
      const { tensor, width, height } = await bufferToTensor(image);
      const disposable = tensor as { dispose(): void };
      let result: HumanResult;
      try {
        result = await h.detect(tensor);
      } finally {
        disposable.dispose();
      }
      if (!result.face || result.face.length === 0) {
        return { width, height, faces: [] };
      }
      const faces = result.face.map((face): ComputeDetectedFace => {
        const [fx, fy, fw, fh] = face.box;
        const rawEmbedding = face.embedding;
        const embedding = rawEmbedding
          ? l2Normalize(Array.from(rawEmbedding))
          : undefined;
        return {
          boundingBox: { x: fx, y: fy, width: fw, height: fh },
          // Human keeps the detector confidence in boxScore; faceScore is 0 in
          // the description-only pipeline. Take the first non-zero score.
          confidence: face.score || face.boxScore || face.faceScore || undefined,
          embedding,
        };
      });
      return { width, height, faces };
    },
  };
}

/**
 * Create (or return the cached) face detector for the given model directory.
 *
 * Lazy singleton per `modelBasePath`: the first call loads tfjs + the WASM
 * backend + Human, registers the fs IOHandler, loads + patches + warms up the
 * models; subsequent calls reuse the same detector. A failed initialization
 * clears the cache entry so the next call retries from scratch.
 */
export function createFaceDetector(opts: { modelBasePath: string }): Promise<FaceDetector> {
  const key = opts.modelBasePath;
  let promise = detectorPromises.get(key);
  if (!promise) {
    promise = initDetector(key).catch((err) => {
      detectorPromises.delete(key);
      throw err;
    });
    detectorPromises.set(key, promise);
  }
  return promise;
}
