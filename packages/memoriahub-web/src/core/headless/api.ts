import { getActiveMemoriahubHost } from './host.js';
import type { MemoriahubApiClient, MemoriahubRequestOptions } from './host.js';

/**
 * A refused API call: the HTTP status, the server's message and, when it sent
 * them, the machine `code` and `details`.
 *
 * @remarks
 * The host's client throws this (or a subclass); slices test `instanceof`.
 *
 * @stability experimental
 */
export class MemoriahubApiError extends Error {
  /** The HTTP status. */
  status: number;
  /** The machine-readable code, when the server sent one. */
  code?: string;
  /** The structured details (`details.reason`, ...), when the server sent them. */
  details?: unknown;

  /**
   * @param message - the server's message.
   * @param status - the HTTP status.
   * @param code - the machine code.
   * @param details - the structured details.
   */
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The API client of the active host, as a value the headless clients call
 * without threading a host through every function.
 *
 * @remarks
 * Every call resolves the active host at call time (`MemoriahubWebHostProvider`
 * binds it), so a client function is usable from a hook, a handler or a plain
 * module, and a test swaps the host once.
 *
 * @stability experimental
 */
export const api: MemoriahubApiClient = {
  get: <T>(endpoint: string, options?: MemoriahubRequestOptions) => getActiveMemoriahubHost().apiClient.get<T>(endpoint, options),
  post: <T>(endpoint: string, body?: unknown, options?: MemoriahubRequestOptions) =>
    getActiveMemoriahubHost().apiClient.post<T>(endpoint, body, options),
  put: <T>(endpoint: string, body?: unknown, options?: MemoriahubRequestOptions) =>
    getActiveMemoriahubHost().apiClient.put<T>(endpoint, body, options),
  patch: <T>(endpoint: string, body?: unknown, options?: MemoriahubRequestOptions) =>
    getActiveMemoriahubHost().apiClient.patch<T>(endpoint, body, options),
  delete: <T>(endpoint: string, options?: MemoriahubRequestOptions) =>
    getActiveMemoriahubHost().apiClient.delete<T>(endpoint, options),
  refreshToken: () => getActiveMemoriahubHost().apiClient.refreshToken(),
  rewriteEndpoint: (endpoint: string) => getActiveMemoriahubHost().apiClient.rewriteEndpoint(endpoint),
  rewriteBody: (endpoint: string, body: unknown) => getActiveMemoriahubHost().apiClient.rewriteBody(endpoint, body),
  getAccessToken: () => getActiveMemoriahubHost().apiClient.getAccessToken(),
  get baseUrl() {
    return getActiveMemoriahubHost().apiClient.baseUrl;
  },
};
