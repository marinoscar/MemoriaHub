// =============================================================================
// CompreFace Core Provider (Keyless)
// =============================================================================
//
// Talks directly to the exadel/compreface-core ML engine container.
// No API key, no CompreFace gateway, no admin UI required.
//
// Container image: exadel/compreface-core:1.2.0-mobilenet
//   Detector:   RetinaFace
//   Calculator: ArcFace MobileFaceNet → 128-dimensional embeddings
//
// Endpoints:
//   GET  {baseUrl}/status
//        → 200 { status: 'OK', available_plugins: {...}, ... }
//
//   POST {baseUrl}/find_faces?face_plugins=calculator&det_prob_threshold=0.8
//        Content-Type: multipart/form-data; field name: file
//        → { result: [ { box: { x_min, y_min, x_max, y_max, probability },
//                         embedding: [128 floats], execution_time: {...} } ] }
//
// HTTP: Node 18+ global fetch + FormData/Blob — no third-party HTTP client.
// =============================================================================

import type {
  FaceProvider,
  FaceCapabilities,
  FaceProviderCredentials,
  DetectedFace,
} from './face-provider.interface';

// ---------------------------------------------------------------------------
// Helper: Buffer → ArrayBuffer
// Node's Buffer may back a SharedArrayBuffer; Blob requires a plain ArrayBuffer.
// ---------------------------------------------------------------------------

function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  const view = new Uint8Array(ab);
  view.set(buf);
  return ab;
}

// ---------------------------------------------------------------------------
// L2 normalization helper
// ---------------------------------------------------------------------------

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map(v => v / norm);
}

// ---------------------------------------------------------------------------
// CompreFace core response shapes (partial — only fields we consume)
// ---------------------------------------------------------------------------

interface ComprefaceCoreBox {
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  probability: number;
}

interface ComprefaceCoreResult {
  box: ComprefaceCoreBox;
  embedding?: number[];
  landmarks?: unknown;
}

interface ComprefaceCoreDetectResponse {
  result: ComprefaceCoreResult[];
}

interface ComprefaceCoreStatusResponse {
  status: string;
  available_plugins?: Record<string, unknown>;
  calculator_version?: string;
}

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
   * The mobilenet build produces 128-dimensional ArcFace embeddings.
   */
  readonly modelVersion = 'compreface-arcface-mobilefacenet-128';

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
  // detect
  // -------------------------------------------------------------------------

  async detect(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<DetectedFace[]> {
    const raw = await this.callFindFaces(creds, image);
    return this.parseResults(raw.result);
  }

  // -------------------------------------------------------------------------
  // embed — reuse find_faces, return embedding of the first face
  // -------------------------------------------------------------------------

  async embed(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<number[]> {
    const raw = await this.callFindFaces(creds, image);
    const first = raw.result[0];
    if (!first?.embedding || first.embedding.length === 0) {
      throw new Error(
        'CompreFace core returned no embedding for the provided image',
      );
    }
    return l2Normalize(first.embedding);
  }

  // -------------------------------------------------------------------------
  // listModels — static; one model per image tag
  // -------------------------------------------------------------------------

  async listModels(_creds: FaceProviderCredentials): Promise<string[]> {
    return [this.modelVersion];
  }

  // -------------------------------------------------------------------------
  // testConnection — GET /status; returns ok:true if status === 'OK'
  // -------------------------------------------------------------------------

  async testConnection(
    creds: FaceProviderCredentials,
  ): Promise<{ ok: boolean; error?: string }> {
    const baseUrl = this.resolveBaseUrl(creds);
    const url = `${baseUrl.replace(/\/$/, '')}/status`;

    try {
      const res = await fetch(url, { method: 'GET' });

      if (!res.ok) {
        return {
          ok: false,
          error: `CompreFace core /status returned HTTP ${res.status}`,
        };
      }

      const body = (await res.json()) as ComprefaceCoreStatusResponse;
      if (body.status !== 'OK') {
        return {
          ok: false,
          error: `CompreFace core reported status: ${body.status}`,
        };
      }

      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Network error: ${message}` };
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildFindFacesUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/$/, '');
    return `${base}/find_faces?face_plugins=calculator&det_prob_threshold=0.8`;
  }

  private async callFindFaces(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<ComprefaceCoreDetectResponse> {
    const baseUrl = this.resolveBaseUrl(creds);
    const url = this.buildFindFacesUrl(baseUrl);

    const form = new FormData();
    form.append(
      'file',
      new Blob([bufferToArrayBuffer(image)], { type: 'image/jpeg' }),
      'image.jpg',
    );

    // No x-api-key header — the core engine is keyless
    const res = await fetch(url, {
      method: 'POST',
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');

      // CompreFace returns 400 when no face is detected — treat as zero detections.
      // This mirrors how testConnection() handles non-2xx responses gracefully.
      if (res.status === 400 && /no face/i.test(body)) {
        return { result: [] };
      }

      throw new Error(
        `CompreFace core /find_faces failed with HTTP ${res.status}: ${body}`,
      );
    }

    return res.json() as Promise<ComprefaceCoreDetectResponse>;
  }

  private parseResults(results: ComprefaceCoreResult[]): DetectedFace[] {
    return results.map(r => {
      const { x_min, y_min, x_max, y_max, probability } = r.box;
      const face: DetectedFace = {
        boundingBox: {
          x: x_min,
          y: y_min,
          w: x_max - x_min,
          h: y_max - y_min,
        },
        confidence: probability,
        landmarks: r.landmarks,
      };

      if (r.embedding && r.embedding.length > 0) {
        face.embedding = l2Normalize(r.embedding);
      }

      return face;
    });
  }
}
