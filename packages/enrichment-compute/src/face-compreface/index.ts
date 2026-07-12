/**
 * CompreFace Core (keyless) face-detection compute (extracted VERBATIM from
 * apps/api/src/face/providers/compreface.provider.ts).
 *
 * This module holds ONLY the pure HTTP compute half: multipart request
 * construction, response parsing, L2-normalization, and the `/status`
 * connectivity probe. Credential/env resolution, the FaceProvider DI
 * interface, and NestJS wiring all stay in the host (the API's
 * ComprefaceProvider, or the CLI worker's face-detection compute module) —
 * `baseUrl` is an explicit parameter here, never resolved from env.
 *
 * Parity contract (docs/specs/distributed-nodes.md §7): a node opting into
 * CompreFace as its face-detection provider must produce byte-for-byte the
 * same HTTP request / response handling as the server's ComprefaceProvider —
 * this module IS that shared logic, imported by both.
 *
 * Container image: exadel/compreface-core:1.2.0-mobilenet
 *   Detector:   RetinaFace
 *   Calculator: ArcFace MobileFaceNet → 128-dimensional embeddings
 *
 * Endpoints:
 *   GET  {baseUrl}/status
 *        → 200 { status: 'OK', available_plugins: {...}, ... }
 *
 *   POST {baseUrl}/find_faces?face_plugins=calculator&det_prob_threshold=0.8
 *        Content-Type: multipart/form-data; field name: file
 *        → { result: [ { box: { x_min, y_min, x_max, y_max, probability },
 *                         embedding: [128 floats], execution_time: {...} } ] }
 *
 * HTTP: Node 18+ global fetch + FormData/Blob — no third-party HTTP client.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ComprefaceDetectedFace {
  /** PIXEL-space bounding box (not normalized 0-1). */
  boundingBox: { x: number; y: number; w: number; h: number };
  confidence: number;
  landmarks?: unknown;
  /** L2-normalized 128-d embedding, present only when the calculator plugin ran. */
  embedding?: number[];
}

/** Pinned model version string — must match ComprefaceProvider.modelVersion server-side. */
export const COMPREFACE_MODEL_VERSION = 'compreface-arcface-mobilefacenet-128';
export const COMPREFACE_PROVIDER_KEY = 'compreface';

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
  return vec.map((v) => v / norm);
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
// find_faces URL + request construction
// ---------------------------------------------------------------------------

function buildFindFacesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/find_faces?face_plugins=calculator&det_prob_threshold=0.8`;
}

async function callFindFaces(
  baseUrl: string,
  image: Buffer,
): Promise<ComprefaceCoreDetectResponse> {
  const url = buildFindFacesUrl(baseUrl);

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
    // This mirrors how the /status probe below handles non-2xx responses gracefully.
    if (res.status === 400 && /no face/i.test(body)) {
      return { result: [] };
    }

    throw new Error(
      `CompreFace core /find_faces failed with HTTP ${res.status}: ${body}`,
    );
  }

  return res.json() as Promise<ComprefaceCoreDetectResponse>;
}

function parseResults(results: ComprefaceCoreResult[]): ComprefaceDetectedFace[] {
  return results.map((r) => {
    const { x_min, y_min, x_max, y_max, probability } = r.box;
    const face: ComprefaceDetectedFace = {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect faces in an image via a CompreFace core sidecar at `baseUrl`.
 * Embeddings, when present, are L2-normalized before being returned.
 */
export async function detectComprefaceFaces(
  baseUrl: string,
  image: Buffer,
): Promise<ComprefaceDetectedFace[]> {
  const raw = await callFindFaces(baseUrl, image);
  return parseResults(raw.result);
}

/**
 * Probe a CompreFace core sidecar's `/status` endpoint. Returns `{ ok: true }`
 * only when HTTP 200 and the body's `status` field is exactly `'OK'`.
 */
export async function testComprefaceStatus(
  baseUrl: string,
): Promise<{ ok: boolean; error?: string }> {
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
