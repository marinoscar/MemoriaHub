// =============================================================================
// CompreFace Provider
// =============================================================================
//
// Default face detection/embedding provider using the CompreFace sidecar.
// Uses the Detection API (with the calculator plugin enabled via ?face_plugins=calculator)
// to simultaneously return bounding boxes and ArcFace embeddings.
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
// CompreFace response shape (partial — only fields we consume)
// ---------------------------------------------------------------------------

interface ComprefaceBox {
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  probability: number;
}

interface ComprefaceResult {
  box: ComprefaceBox;
  embedding?: number[];
  landmarks?: unknown;
}

interface ComprefaceDetectResponse {
  result: ComprefaceResult[];
}

export class ComprefaceProvider implements FaceProvider {
  readonly key = 'compreface';

  readonly capabilities: FaceCapabilities = {
    detect: true,
    embed: true,
    delegatedRecognize: false,
  };

  readonly modelVersion = 'arcface-r100-v1';

  // -------------------------------------------------------------------------
  // detect
  // -------------------------------------------------------------------------

  async detect(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<DetectedFace[]> {
    const raw = await this.callDetectApi(creds, image);
    return this.parseResults(raw.result);
  }

  // -------------------------------------------------------------------------
  // embed — reuse the detect endpoint, return embedding of the first face
  // -------------------------------------------------------------------------

  async embed(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<number[]> {
    const raw = await this.callDetectApi(creds, image);
    const first = raw.result[0];
    if (!first?.embedding || first.embedding.length === 0) {
      throw new Error('CompreFace returned no embedding for the provided image');
    }
    return l2Normalize(first.embedding);
  }

  // -------------------------------------------------------------------------
  // listModels — static; CompreFace model is fixed per deployment
  // -------------------------------------------------------------------------

  async listModels(_creds: FaceProviderCredentials): Promise<string[]> {
    return [this.modelVersion];
  }

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  async testConnection(
    creds: FaceProviderCredentials,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!creds.baseUrl) {
      return { ok: false, error: 'baseUrl is required for CompreFace' };
    }
    if (!creds.apiKey) {
      return { ok: false, error: 'apiKey is required for CompreFace' };
    }

    // Send a 1×1 white JPEG — CompreFace will return 400-level "no face detected"
    // which still proves the service is reachable and the key is accepted.
    const tinyJpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
        'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
        'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
        'MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB' +
        '/8QAIRAAAQMEAgMAAAAAAAAAAAAAAQIDBAUREiExQVH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA' +
        '/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AltJagyeH0AthI5xdrLcNM91' +
        'BF5pX2HaH9bcfaSXWGaRmknyJckliyjqTzSlT54b6bk+h0R//2Q==',
      'base64',
    );

    try {
      const url = this.buildDetectUrl(creds.baseUrl);
      const form = new FormData();
      form.append('file', new Blob([bufferToArrayBuffer(tinyJpeg)], { type: 'image/jpeg' }), 'test.jpg');

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-api-key': creds.apiKey },
        body: form,
      });

      if (res.ok) return { ok: true };

      // 400 "no face" or similar 4xx that isn't auth/routing = connectivity proven
      if (res.status === 400 || (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 404)) {
        return { ok: true };
      }

      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `Authentication rejected (HTTP ${res.status}) — check x-api-key` };
      }

      return { ok: false, error: `Unexpected HTTP ${res.status} from CompreFace` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Network error: ${message}` };
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildDetectUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/$/, '');
    return `${base}/api/v1/detection/detect?face_plugins=calculator`;
  }

  private async callDetectApi(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<ComprefaceDetectResponse> {
    if (!creds.baseUrl) {
      throw new Error('CompreFace baseUrl is not configured');
    }
    if (!creds.apiKey) {
      throw new Error('CompreFace apiKey is not configured');
    }

    const url = this.buildDetectUrl(creds.baseUrl);
    const form = new FormData();
    form.append('file', new Blob([bufferToArrayBuffer(image)], { type: 'image/jpeg' }), 'image.jpg');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': creds.apiKey },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `CompreFace detect failed with HTTP ${res.status}: ${body}`,
      );
    }

    return res.json() as Promise<ComprefaceDetectResponse>;
  }

  private parseResults(results: ComprefaceResult[]): DetectedFace[] {
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
