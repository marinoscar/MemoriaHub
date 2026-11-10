import type { MemoriahubSecretStatus, MemoriahubSecretsPort } from '../ports/index.js';

/**
 * An in-memory `MEMORIAHUB_SECRETS`. A purpose must be registered before a secret is stored under it;
 * `status` returns a hint and a date, never the value.
 *
 * @stability experimental
 */
export class FakeMemoriahubSecrets implements MemoriahubSecretsPort {
  private readonly purposes = new Map<string, string>();

  private readonly values = new Map<string, { value: string; updatedAt: Date }>();

  /** Declares a purpose. */
  registerPurpose(purpose: string, label: string): void {
    if (!this.purposes.has(purpose)) this.purposes.set(purpose, label);
  }

  /** The value, or `null`. */
  async get(purpose: string, name: string): Promise<string | null> {
    return this.values.get(`${purpose}/${name}`)?.value ?? null;
  }

  /** Stores a value. */
  async set(purpose: string, name: string, value: string, _actorUserId: string): Promise<void> {
    if (!this.purposes.has(purpose)) throw new Error(`The credential purpose "${purpose}" is not registered`);
    this.values.set(`${purpose}/${name}`, { value, updatedAt: new Date() });
  }

  /** Removes a value. */
  async delete(purpose: string, name: string, _actorUserId: string): Promise<void> {
    this.values.delete(`${purpose}/${name}`);
  }

  /** The status, never the value. */
  async status(purpose: string, name: string): Promise<MemoriahubSecretStatus> {
    const entry = this.values.get(`${purpose}/${name}`);
    if (!entry) return { configured: false, hint: null, updatedAt: null };
    return { configured: true, hint: entry.value.slice(-4), updatedAt: entry.updatedAt.toISOString() };
  }
}
