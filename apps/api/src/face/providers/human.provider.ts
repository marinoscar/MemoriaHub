// =============================================================================
// Human Provider — @vladmandic/human (WASM backend, in-process, keyless)
// =============================================================================
//
// THIN ADAPTER: all model math now lives in the shared parity package
// @memoriahub/enrichment-compute/face (see docs/specs/distributed-nodes.md §7)
// so a face embedding computed on a distributed worker node is numerically
// identical to one computed here. The package holds the Human config, the
// fs-backed IOHandler (registered on Human's OWN bundled tf instance), the
// faceres 1024-d embedding output patch (global_pooling/Mean), buffer→tensor
// decode, and L2-normalization.
//
// What stays HERE (host concerns, per the compute/persist split):
//   - the FaceProvider interface + credential plumbing (keyless: ignored)
//   - the FACE_HUMAN_MODEL_PATH env read (the package never reads env vars)
//   - bounding-box normalization: the package returns PIXEL coords exactly as
//     Human does; we normalize to [0,1] fractions against the decoded input
//     dimensions, same as this provider always did.
//
// modelVersion: 'human-faceres-1024' — identifies the embedding model + dim
// (re-exported from the package so server and node can never drift).
// =============================================================================

import {
  createFaceDetector,
  FACE_MODEL_VERSION,
  FACE_PROVIDER_KEY,
} from '@memoriahub/enrichment-compute/face';
import type {
  FaceProvider,
  FaceCapabilities,
  FaceProviderCredentials,
  DetectedFace,
} from './face-provider.interface';

// The env read stays API-side; the package takes modelBasePath as a parameter.
const MODEL_PATH = process.env.FACE_HUMAN_MODEL_PATH ?? '/app/models/human';

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class HumanProvider implements FaceProvider {
  readonly key = FACE_PROVIDER_KEY;
  readonly capabilities: FaceCapabilities = {
    detect: true,
    embed: true,
    delegatedRecognize: false,
  };
  readonly modelVersion = FACE_MODEL_VERSION;
  readonly requiresCredentials = false;

  async detect(
    _creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<DetectedFace[]> {
    const detector = await createFaceDetector({ modelBasePath: MODEL_PATH });
    const { width, height, faces } = await detector.detect(image);
    return faces.map(face => ({
      boundingBox: {
        x: face.boundingBox.x / width,
        y: face.boundingBox.y / height,
        w: face.boundingBox.width / width,
        h: face.boundingBox.height / height,
      },
      confidence: face.confidence,
      embedding: face.embedding,
    }));
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
      await createFaceDetector({ modelBasePath: MODEL_PATH });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
