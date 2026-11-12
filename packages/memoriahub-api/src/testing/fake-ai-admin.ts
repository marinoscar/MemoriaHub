import type {
  MemoriahubAiAdminPort,
  MemoriahubAiCredentialStatus,
  MemoriahubAiEmbeddingProbeResult,
  MemoriahubAiProbeResult,
  MemoriahubAiProviderCapabilities,
} from '../ports/index.js';

/**
 * A fake `MEMORIAHUB_AI_ADMIN`: what a test sets in `models`, `embedding`, `credentials` and `capabilities`
 * is what the probes answer. A model with no entry answers `{ ok: true }`, a provider with no key entry is
 * unconfigured, a provider with no capabilities entry is unknown (`null`). Every probe is recorded in `calls`.
 *
 * @stability experimental
 */
export class FakeMemoriahubAiAdmin implements MemoriahubAiAdminPort {
  /** Answers of `testModel`, by `provider/model`. */
  readonly models = new Map<string, MemoriahubAiProbeResult>();

  /** The answer of `testEmbedding`. */
  embedding: MemoriahubAiEmbeddingProbeResult = { ok: true, dimensions: 1536 };

  /** Key status, by provider. */
  readonly credentials = new Map<string, MemoriahubAiCredentialStatus>();

  /** Capabilities, by provider. */
  readonly capabilities = new Map<string, MemoriahubAiProviderCapabilities>();

  /** Every probe, in order. */
  readonly calls: string[] = [];

  /** Tests a model. */
  async testModel(target: { provider: string; model: string }): Promise<MemoriahubAiProbeResult> {
    this.calls.push(`testModel:${target.provider}/${target.model}`);
    return this.models.get(`${target.provider}/${target.model}`) ?? { ok: true };
  }

  /** Tests the embedding. */
  async testEmbedding(): Promise<MemoriahubAiEmbeddingProbeResult> {
    this.calls.push('testEmbedding');
    return this.embedding;
  }

  /** Key status of a provider. */
  async credentialStatus(provider: string): Promise<MemoriahubAiCredentialStatus> {
    this.calls.push(`credentialStatus:${provider}`);
    return this.credentials.get(provider) ?? { configured: false, enabled: false };
  }

  /** Capabilities of a provider, or `null` when unknown. */
  providerCapabilities(provider: string): MemoriahubAiProviderCapabilities | null {
    return this.capabilities.get(provider) ?? null;
  }
}
