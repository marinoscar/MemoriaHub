// =============================================================================
// Human Provider — @vladmandic/human (WASM backend, in-process, keyless)
// =============================================================================
//
// Uses @vladmandic/human with the WASM TensorFlow backend so it runs on
// Alpine Linux (musl libc) where tfjs-node native binaries are unavailable.
//
// Models loaded at first use (lazy singleton). Image buffers are decoded to
// raw RGBA via `sharp` (already a dep) then fed to Human as a tf.Tensor3D.
//
// Bounding box: Human returns pixel coords relative to input. We normalize
// to [0,1] fractions by dividing by image width/height.
//
// Embedding: Human's face descriptor is a 1024-element Float32Array from the
// faceres model. We L2-normalize it to match CompreFace behavior.
//
// modelVersion: 'human-faceres-1024' — identifies the embedding model + dim.
//
// Runtime quirks fixed here (Alpine/WASM-only environment):
//
// 1. file:// IOHandler: Node's global fetch (undici) does NOT support the
//    file:// scheme.  @tensorflow/tfjs-node ships a native file:// handler but
//    requires glibc and cannot be installed on Alpine/musl.  We register a
//    custom fs-backed IOHandler on Human's OWN bundled tf instance (h.tf) so
//    that Human can read model weights from disk.  Registering on the umbrella
//    @tensorflow/tfjs package has no effect — Human uses its own bundled copy.
//
// 2. faceres embedding output: The faceres.json model's graph only declares
//    two output nodes: gender_pred/Sigmoid [1,1] and age_pred/Softmax [1,100].
//    The 1024-d face embedding lives at the intermediate node
//    'global_pooling/Mean' which feeds the downstream dense layer but is never
//    wired as a declared output.  Human's description predictor (I5) scans
//    execute() outputs for a tensor with shape[1]===1024 and falls back to []
//    when none is found (producing EMBEDDING_LEN: 0).  After h.load() we
//    patch the GraphModelExecutor._outputs array to include the embedding node,
//    so execute() returns the full triple [gender, age-bins, embedding].
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import type {
  FaceProvider,
  FaceCapabilities,
  FaceProviderCredentials,
  DetectedFace,
} from './face-provider.interface';

// Load TF WASM backend and tfjs via require to avoid missing-module TS errors
// when the package is not installed in the local dev tree (Docker-first project).
// These packages are runtime deps and present in the Docker image after npm install.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const tf: any = require('@tensorflow/tfjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@tensorflow/tfjs-backend-wasm');

// Load Human from the WASM build. The package's "node" export condition maps to
// dist/human.node.js, which hard-requires @tensorflow/tfjs-node — a native glibc
// binary unavailable on Alpine (musl). The package's dist/* subpath keys in
// `exports` lack the required leading "./", so a bare
// `require('@vladmandic/human/dist/human.node-wasm.js')` fails at module load
// with ERR_PACKAGE_PATH_NOT_EXPORTED. We therefore resolve the package main to
// its absolute dist dir and require the node-wasm build by ABSOLUTE path, which
// bypasses the exports map and loads the pure-JS + WASM build (no tfjs-node;
// runs on any libc).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const humanPkgMain: string = require.resolve('@vladmandic/human');
const humanWasmPath = path.join(path.dirname(humanPkgMain), 'human.node-wasm.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const humanWasmModule: any = require(humanWasmPath);
// node-wasm exports Human as a named export; fall back through .default chain
// for forward compatibility.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
const HumanClass: new (config: unknown) => HumanInstance =
  humanWasmModule.Human ?? humanWasmModule.default?.Human ?? humanWasmModule.default ?? humanWasmModule;

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
interface HumanInstance {
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MODEL_PATH = process.env.FACE_HUMAN_MODEL_PATH ?? '/app/models/human';

function resolveWasmPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkgPath = require.resolve('@tensorflow/tfjs-backend-wasm/package.json');
    return path.join(path.dirname(pkgPath), 'dist') + path.sep;
  } catch {
    // Fallback for environments where the package isn't installed locally
    return path.join('node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist') + path.sep;
  }
}

const humanConfig = {
  backend: 'wasm',
  wasmPath: resolveWasmPath(),
  modelBasePath: `file://${MODEL_PATH}/`,
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

function fileSystemIOHandler(url: string): { load(): Promise<unknown> } {
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

function patchFaceresEmbeddingOutput(h: HumanInstance): void {
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
// Singleton initialisation
// ---------------------------------------------------------------------------

let humanInstance: HumanInstance | null = null;
let initPromise: Promise<HumanInstance> | null = null;

async function getHuman(): Promise<HumanInstance> {
  if (humanInstance) return humanInstance;
  if (!initPromise) {
    initPromise = (async () => {
      // Prime the umbrella tf backend (belt-and-suspenders; Human's own tf
      // initialises itself, but this keeps the umbrella instance consistent).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await tf.setBackend('wasm');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await tf.ready();

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
      const h: HumanInstance = new HumanClass(humanConfig);

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
      humanInstance = h;
      return h;
    })().catch(err => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function bufferToTensor(
  image: Buffer,
): Promise<{ tensor: unknown; width: number; height: number }> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 4]) as { dispose(): void };
  return { tensor, width: info.width, height: info.height };
}

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map(v => v / norm);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class HumanProvider implements FaceProvider {
  readonly key = 'human';
  readonly capabilities: FaceCapabilities = {
    detect: true,
    embed: true,
    delegatedRecognize: false,
  };
  readonly modelVersion = 'human-faceres-1024';
  readonly requiresCredentials = false;

  async detect(
    _creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<DetectedFace[]> {
    const h = await getHuman();
    const { tensor, width, height } = await bufferToTensor(image);
    const disposable = tensor as { dispose(): void };
    let result: HumanResult;
    try {
      result = await h.detect(tensor);
    } finally {
      disposable.dispose();
    }
    if (!result.face || result.face.length === 0) return [];
    return result.face.map(face => {
      const [fx, fy, fw, fh] = face.box;
      const rawEmbedding = face.embedding;
      const embedding = rawEmbedding
        ? l2Normalize(Array.from(rawEmbedding))
        : undefined;
      return {
        boundingBox: {
          x: fx / width,
          y: fy / height,
          w: fw / width,
          h: fh / height,
        },
        // Human keeps the detector confidence in boxScore; faceScore is 0 in
        // the description-only pipeline. Take the first non-zero score.
        confidence: face.score || face.boxScore || face.faceScore || undefined,
        embedding,
      };
    });
  }

  async embed(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<number[]> {
    const faces = await this.detect(creds, image);
    if (faces.length === 0) {
      throw new Error('No face detected in image');
    }
    if (!faces[0].embedding) {
      throw new Error('No embedding produced for detected face');
    }
    return faces[0].embedding;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listModels(_creds: FaceProviderCredentials): Promise<string[]> {
    return [this.modelVersion];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async testConnection(_creds: FaceProviderCredentials): Promise<{ ok: boolean; error?: string }> {
    try {
      await getHuman();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
