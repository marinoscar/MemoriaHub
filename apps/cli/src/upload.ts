import * as fs from 'fs';
import { ApiClient } from './api.js';

export interface UploadResult {
  objectId: string;
}

interface InitUploadResponse {
  objectId: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  presignedUrls: Array<{ partNumber: number; url: string }>;
}

interface PartUrlsResponse {
  presignedUrls: Array<{ partNumber: number; url: string }>;
}

const MAX_RETRIES = 3;
const BATCH_PART_URLS = 50; // how many part numbers to request at once

/**
 * Read a slice of a file into a Buffer.
 */
function readFileSlice(
  filePath: string,
  start: number,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(filePath, {
      start,
      end: start + length - 1, // end is inclusive in createReadStream
    });
    stream.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Upload one part with retries. Returns the ETag.
 */
async function uploadPartWithRetry(
  api: ApiClient,
  url: string,
  buffer: Buffer,
  partNumber: number,
  mimeType: string,
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await api.putRaw(url, buffer, mimeType);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 1000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw new Error(
    `Part ${partNumber} failed after ${MAX_RETRIES} attempts: ${lastErr?.message}`,
  );
}

/**
 * Fetch presigned URLs for a batch of part numbers from the server.
 */
async function fetchPartUrls(
  api: ApiClient,
  objectId: string,
  partNumbers: number[],
): Promise<Map<number, string>> {
  const resp = await api.post<PartUrlsResponse>(
    `/api/storage/objects/${objectId}/upload/part-urls`,
    { partNumbers },
  );
  const map = new Map<number, string>();
  for (const { partNumber, url } of resp.presignedUrls) {
    map.set(partNumber, url);
  }
  return map;
}

/**
 * Upload a file using the resumable multipart upload flow.
 *
 * Flow:
 *   1. POST /api/storage/objects/upload/init  → objectId, partSize, totalParts, first ≤10 URLs
 *   2. For each part:
 *      - Use URL from init response if available (parts 1-10)
 *      - Otherwise batch-fetch URLs via POST :id/upload/part-urls
 *      - PUT the part slice directly to the presigned URL
 *   3. POST :id/upload/complete  → finalize
 */
export async function uploadFile(
  api: ApiClient,
  filePath: string,
  mimeType: string,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const fileName = filePath.split('/').pop() ?? filePath;

  // 1. Initialize upload
  const init = await api.post<InitUploadResponse>(
    '/api/storage/objects/upload/init',
    { name: fileName, size: fileSize, mimeType },
  );

  const { objectId, partSize, totalParts, presignedUrls: initUrls } = init;

  // Build a map of part number → URL from the init response
  const urlCache = new Map<number, string>();
  for (const { partNumber, url } of initUrls) {
    urlCache.set(partNumber, url);
  }

  const completedParts: Array<{ partNumber: number; eTag: string }> = [];

  // 2. Upload each part
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    // Ensure URL is available; batch-fetch if not
    if (!urlCache.has(partNumber)) {
      // Fetch this part and the next BATCH_PART_URLS-1 part numbers at once
      const need: number[] = [];
      for (
        let n = partNumber;
        n <= Math.min(totalParts, partNumber + BATCH_PART_URLS - 1);
        n++
      ) {
        if (!urlCache.has(n)) {
          need.push(n);
        }
      }
      const fetched = await fetchPartUrls(api, objectId, need);
      for (const [n, u] of fetched) {
        urlCache.set(n, u);
      }
    }

    const url = urlCache.get(partNumber)!;
    const start = (partNumber - 1) * partSize;
    const length = Math.min(partSize, fileSize - start);
    const buffer = await readFileSlice(filePath, start, length);

    const eTag = await uploadPartWithRetry(api, url, buffer, partNumber, mimeType);
    completedParts.push({ partNumber, eTag });

    if (onProgress) {
      onProgress(partNumber / totalParts);
    }
  }

  // 3. Complete upload
  await api.post(`/api/storage/objects/${objectId}/upload/complete`, {
    parts: completedParts,
  });

  return { objectId };
}
