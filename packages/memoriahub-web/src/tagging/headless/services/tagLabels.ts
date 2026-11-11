import { api } from '../../../core/headless/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Tag Label.
 *
 * @stability experimental
 */
export interface TagLabel {
  /** The `id`. */
  id: string;
  /** The `name`. */
  name: string;
  /** The `enabled`. */
  enabled: boolean;
  /** The `createdAt`. */
  createdAt: string;
  /** The `updatedAt`. */
  updatedAt: string;
}

/**
 * Import Result.
 *
 * @stability experimental
 */
export interface ImportResult {
  /** The `created`. */
  created: number;
  /** The `updated`. */
  updated: number;
  /** The `deleted`. */
  deleted: number;
  /** The `errors`. */
  errors: { row: number; message: string }[];
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * List Tag Labels.
 *
 * @stability experimental
 */
export async function listTagLabels(): Promise<TagLabel[]> {
  return api.get<TagLabel[]>('/tag-labels');
}

/**
 * Create Tag Label.
 *
 * @stability experimental
 */
export async function createTagLabel(body: { name: string }): Promise<TagLabel> {
  return api.post<TagLabel>('/tag-labels', body);
}

/**
 * Update Tag Label.
 *
 * @stability experimental
 */
export async function updateTagLabel(
  id: string,
  body: { name?: string; enabled?: boolean },
): Promise<TagLabel> {
  return api.patch<TagLabel>(`/tag-labels/${id}`, body);
}

/**
 * Delete Tag Label.
 *
 * @stability experimental
 */
export async function deleteTagLabel(id: string): Promise<void> {
  await api.delete<void>(`/tag-labels/${id}`);
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/**
 * Fetch the tag labels CSV from GET /api/tag-labels/export.
 * Bypasses the JSON-unwrapping api client because the response is a raw
 * text/csv attachment, not a JSON envelope.
 * Returns the raw Blob so the caller can trigger a browser download.
 *
 * @stability experimental
 */
export async function exportTagLabels(): Promise<Blob> {
  const token = api.getAccessToken();
  const headers: HeadersInit = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${api.baseUrl}/tag-labels/export`, {
    method: 'GET',
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    let message = `Export failed: ${response.status} ${response.statusText}`;
    try {
      const bodyJson = JSON.parse(bodyText) as { message?: string };
      if (bodyJson.message) message = bodyJson.message;
    } catch {
      if (bodyText) message = bodyText;
    }
    const err = new Error(message) as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  return response.blob();
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

/**
 * Upload a CSV file to POST /api/tag-labels/import (multipart/form-data).
 * The field name is `file`. The API returns { created, updated, deleted, errors }
 * unwrapped from the standard { data } envelope by the api client.
 *
 * Uses a raw fetch (not the JSON-unwrapping api client) so we can send
 * FormData without a Content-Type header (the browser sets it with the
 * multipart boundary automatically).
 *
 * @stability experimental
 */
export async function importTagLabels(file: File): Promise<ImportResult> {
  const token = api.getAccessToken();
  const headers: HeadersInit = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${api.baseUrl}/tag-labels/import`, {
    method: 'POST',
    headers,
    body: formData,
    credentials: 'include',
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    let message = `Import failed: ${response.status} ${response.statusText}`;
    try {
      const bodyJson = JSON.parse(bodyText) as { message?: string };
      if (bodyJson.message) message = bodyJson.message;
    } catch {
      if (bodyText) message = bodyText;
    }
    const err = new Error(message) as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  // Unwrap { data: { ... } } envelope if present (matches api client behaviour)
  return (data.data ?? data) as ImportResult;
}
