// =============================================================================
// Job Credentials DTOs (transient per-job provider credentials)
// =============================================================================
//
// Response shapes for POST /api/nodes/:id/jobs/:jobId/credentials.
//
// DESIGN NOTE: docs/specs/distributed-nodes.md documents an "AI-proxy"
// pattern (node never sees the provider key; the server proxies the call).
// That pattern was explicitly rejected for auto_tagging/geocode. Instead the
// node fetches these TRANSIENT, per-job credentials and calls the provider's
// HTTP API directly. `apiKey` here is scoped to a single job and MUST NEVER
// be persisted to disk/config/logs by the CLI, and MUST NEVER be logged
// server-side (see NodesService.getJobCredentials for the redaction
// verification note — no interceptor in this app logs response bodies).
// =============================================================================

export interface AutoTaggingJobCredentials {
  type: 'auto_tagging';
  /** Configured tagging provider key, e.g. 'anthropic'. */
  provider: string;
  model: string;
  /** Plaintext API key, decrypted server-side for this call only. */
  apiKey: string;
  baseUrl?: string;
  /** Shared verbatim with the in-process path — see AutoTaggingService.buildPrompt. */
  system: string;
  prompt: string;
  /** Always 'image/jpeg' — the node re-encodes via prepareImageForProcessing before this call. */
  mimeTypeHint: string;
}

export interface GeocodeJobCredentials {
  type: 'geocode';
  /**
   * Active reverse-geocode provider. 'offline' means the server-side GeoNames
   * dataset is active — a node has no equivalent dataset and MUST decline
   * (CapabilityUnavailableError) rather than attempt a lookup.
   */
  provider: 'offline' | 'nominatim' | 'google';
  /** Only present for provider='google'. */
  apiKey?: string;
  /** Only present for provider='nominatim' (base URL override). */
  baseUrl?: string;
  lat: number;
  lng: number;
}

export type JobCredentialsResult = AutoTaggingJobCredentials | GeocodeJobCredentials;
