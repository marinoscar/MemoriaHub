// =============================================================================
// MEMORIAHUB_AI_ADMIN: the AI administration probe port (RETRO-J10, #624)
// =============================================================================
//
// What an operator's diagnostics need to know about the AI configuration that `MEMORIAHUB_AI` (the call path
// a feature uses) does not say: does the chosen provider and model answer, is there a key for a provider,
// and what can a provider do (speech to text). The web edition binds it over its AI admin service and the
// platform provider registry; a host without an AI administration page leaves it unbound.
//
// THE PROBES ARE LIVE: `testModel` and `testEmbedding` make one small provider call and spend a few tokens,
// which is why a diagnostics check that uses them says so in its documentation. Nothing here writes, and no
// result carries key material: a key is reported only as "configured and enabled" (presentation-safe).
//
// Optional: an unbound port means a check that needs it is skipped ("not available in this host").
// =============================================================================

/**
 * Injection token of {@link MemoriahubAiAdminPort}. The description string is permanent. Optional in
 * `MemoriahubPortsModule.forRoot`: the checks that need it are skipped when it is unbound.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_AI_ADMIN = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_AI_ADMIN');

/**
 * The answer of a live model probe.
 *
 * @stability experimental
 */
export interface MemoriahubAiProbeResult {
  /** True when the provider answered. */
  ok: boolean;
  /** Why it did not (a sanitized message), when `ok` is false. */
  error?: string;
}

/**
 * The answer of a live embedding probe.
 *
 * @stability experimental
 */
export interface MemoriahubAiEmbeddingProbeResult extends MemoriahubAiProbeResult {
  /** The vector size the model returned. */
  dimensions?: number;
  /** A configuration problem that is not a failure (the vectors do not fit the storage size). */
  warning?: string;
}

/**
 * Whether a provider has a usable key, presentation-safe (never the key).
 *
 * @stability experimental
 */
export interface MemoriahubAiCredentialStatus {
  /** True when the deployment (or the organization) holds a key for the provider. */
  configured: boolean;
  /** True when that key is switched on. */
  enabled: boolean;
}

/**
 * What a provider can do.
 *
 * @stability experimental
 */
export interface MemoriahubAiProviderCapabilities {
  /** True when the provider can transcribe audio (speech to text). */
  transcribeAudio: boolean;
}

/**
 * The AI administration probe port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubAiAdminPort {
  /**
   * Asks one provider and model for a minimal answer, on the same call path a job takes. Spends a few
   * tokens. Never rejects for a provider fault: it answers `{ ok: false, error }`.
   *
   * @param target - the provider and model to test.
   */
  testModel(target: { provider: string; model: string }): Promise<MemoriahubAiProbeResult>;

  /**
   * Embeds one short text with the configured embedding provider and model. Spends a few tokens. Answers
   * `{ ok: false, error }` when none is configured or the provider fails.
   */
  testEmbedding(): Promise<MemoriahubAiEmbeddingProbeResult>;

  /**
   * Whether a provider has a key, and whether it is switched on. Never decrypts or returns the key.
   *
   * @param provider - the provider key (`openai`, `anthropic`).
   */
  credentialStatus(provider: string): Promise<MemoriahubAiCredentialStatus>;

  /**
   * What a provider can do, or `null` when the host does not know the provider (a diagnostic reports a
   * misconfiguration; it never becomes one).
   *
   * @param provider - the provider key.
   */
  providerCapabilities(provider: string): MemoriahubAiProviderCapabilities | null;
}
