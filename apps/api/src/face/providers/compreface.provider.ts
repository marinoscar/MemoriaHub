// =============================================================================
// CompreFace Core Provider (Keyless)
// =============================================================================
//
// Talks directly to the exadel/compreface-core ML engine container.
// No API key, no CompreFace gateway, no admin UI required.
//
// This is now a THIN ADAPTER: the actual HTTP protocol (find_faces multipart
// request, response parsing, L2-normalize, /status probe) lives in the shared
// @memoriahub/enrichment-compute/face-compreface package, imported identically
// by this provider (server, DI-wired) and by a distributed worker node opting
// into CompreFace as its face-detection provider (apps/cli), so both sides
// send byte-identical requests and parse responses identically. This class
// still owns credential/env resolution and the FaceProvider DI interface.
//
// Container image: exadel/compreface-core:1.2.0-mobilenet
//   Detector:   RetinaFace
//   Calculator: ArcFace MobileFaceNet → 128-dimensional embeddings
// =============================================================================

import {
  detectComprefaceFaces,
  testComprefaceStatus,
  COMPREFACE_MODEL_VERSION,
} from '@memoriahub/enrichment-compute/face-compreface';
import type {
  FaceProvider,
  FaceCapabilities,
  FaceProviderCredentials,
  DetectedFace,
} from './face-provider.interface';

// ---------------------------------------------------------------------------
// Default URL (overridden by stored credential baseUrl or FACE_COMPREFACE_URL)
// ---------------------------------------------------------------------------

const DEFAULT_COMPREFACE_URL = 'http://compreface-core:3000';

export class ComprefaceProvider implements FaceProvider {
  readonly key = 'compreface';

  readonly capabilities: FaceCapabilities = {
    detect: true,
    embed: true,
    delegatedRecognize: false,
  };

  /**
   * Pinned model version string — includes provider, algorithm, and embedding
   * dimensionality so that face rows can be invalidated if the model changes.
   * The mobilenet build produces 128-dimensional ArcFace embeddings. Sourced
   * from the shared package so the server and a CompreFace-opted-in worker
   * node always tag Face rows with the identical model version string.
   */
  readonly modelVersion = COMPREFACE_MODEL_VERSION;

  /**
   * No API key is needed — the compreface-core container is accessed directly
   * on the docker network. A credential row may optionally store a custom baseUrl.
   */
  readonly requiresCredentials = false;

  // -------------------------------------------------------------------------
  // baseUrl resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the effective base URL, in priority order:
   *   1. Stored credential row's baseUrl (set via PUT /api/face/credentials/compreface)
   *   2. FACE_COMPREFACE_URL environment variable
   *   3. Hard-coded docker-network default: http://compreface-core:3000
   */
  private resolveBaseUrl(creds: FaceProviderCredentials): string {
    return (
      creds.baseUrl?.trim() ||
      process.env.FACE_COMPREFACE_URL?.trim() ||
      DEFAULT_COMPREFACE_URL
    );
  }

  // -------------------------------------------------------------------------
  // detect — delegates to the shared package's find_faces client
  // -------------------------------------------------------------------------

  async detect(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<DetectedFace[]> {
    return detectComprefaceFaces(this.resolveBaseUrl(creds), image);
  }

  // -------------------------------------------------------------------------
  // embed — reuse detect, return the (already L2-normalized) embedding of the
  // first face
  // -------------------------------------------------------------------------

  async embed(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<number[]> {
    const faces = await detectComprefaceFaces(this.resolveBaseUrl(creds), image);
    const first = faces[0];
    if (!first?.embedding || first.embedding.length === 0) {
      throw new Error(
        'CompreFace core returned no embedding for the provided image',
      );
    }
    return first.embedding;
  }

  // -------------------------------------------------------------------------
  // listModels — static; one model per image tag
  // -------------------------------------------------------------------------

  async listModels(_creds: FaceProviderCredentials): Promise<string[]> {
    return [this.modelVersion];
  }

  // -------------------------------------------------------------------------
  // testConnection — delegates to the shared package's /status probe
  // -------------------------------------------------------------------------

  async testConnection(
    creds: FaceProviderCredentials,
  ): Promise<{ ok: boolean; error?: string }> {
    return testComprefaceStatus(this.resolveBaseUrl(creds));
  }
}
