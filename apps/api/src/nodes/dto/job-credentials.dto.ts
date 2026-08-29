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

/**
 * Transient credentials for a node-computed `video_auto_tagging` job
 * (epic #452, issue #460).
 *
 * Differs from `AutoTaggingJobCredentials` in two ways, both because a video
 * prompt depends on values only the node knows:
 *
 *   - `prompt` is ABSENT. The user prompt embeds the sampled frame timestamps,
 *     which the node produces. It hands over `labelNames` and `peopleNames`
 *     instead (both need DB access a node does not have) and the node composes
 *     the prompt with the same shared `buildVideoPrompt`.
 *   - `transcription` carries a SECOND, independent provider credential. It is
 *     absent when transcription is off, unconfigured, or unresolvable — in
 *     which case the node tags visual-only, matching the in-process path's
 *     degradation exactly.
 *
 * Both `apiKey` fields are plaintext, scoped to a single job, and MUST NEVER
 * be persisted to disk/config/logs by the CLI.
 */
export interface VideoAutoTaggingJobCredentials {
  type: 'video_auto_tagging';
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** Fixed system prompt — shared verbatim with the in-process path. */
  system: string;
  /** Enabled TagLabel vocabulary; the node cannot read it itself. */
  labelNames: string[];
  /** Assigned people on this item, for the prompt's name clause. */
  peopleNames: string[];
  transcription?: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
  };
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

export type JobCredentialsResult =
  | AutoTaggingJobCredentials
  | VideoAutoTaggingJobCredentials
  | GeocodeJobCredentials;
