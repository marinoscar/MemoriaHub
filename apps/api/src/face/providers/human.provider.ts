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
// =============================================================================

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

// Load Human from the WASM build by requiring the explicit file path.
// `require('@vladmandic/human')` resolves via the package's exports-map
// "require" entry to dist/human.node.js, which hard-requires
// @tensorflow/tfjs-node — a native glibc binary unavailable on Alpine (musl).
// Bypassing the exports map by requiring the file path directly loads the
// pure-JS + WASM build that runs on any libc.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const humanWasmModule: any = require('@vladmandic/human/dist/human.node-wasm.js');
// node-wasm exports Human as a named export; fall back through .default chain
// for forward compatibility.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
const HumanClass: new (config: unknown) => HumanInstance =
  humanWasmModule.Human ?? humanWasmModule.default?.Human ?? humanWasmModule.default ?? humanWasmModule;

interface FaceResult {
  box: [number, number, number, number];
  faceScore?: number;
  score?: number;
  embedding?: Float32Array | number[];
}

interface HumanResult {
  face?: FaceResult[];
}

interface HumanInstance {
  load(): Promise<void>;
  warmup(): Promise<void>;
  detect(input: unknown): Promise<HumanResult>;
}

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

let humanInstance: HumanInstance | null = null;
let initPromise: Promise<HumanInstance> | null = null;

async function getHuman(): Promise<HumanInstance> {
  if (humanInstance) return humanInstance;
  if (!initPromise) {
    initPromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await tf.setBackend('wasm');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await tf.ready();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
      const h: HumanInstance = new HumanClass(humanConfig);
      await h.load();
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
        confidence: face.faceScore ?? face.score ?? undefined,
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
