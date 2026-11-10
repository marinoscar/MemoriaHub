import type { MemoriahubSecretStatus, MemoriahubSecretsPort } from '../../../src/ports/index.js';

/**
 * An in-memory `MEMORIAHUB_SECRETS` double that records every call, so a test can assert that nothing
 * but the secret store ever saw a secret. The hint is masked the way the platform store masks it.
 */
export class FakeCredentials implements MemoriahubSecretsPort {
  readonly rows = new Map<string, { secret: string; hint: string; updatedAt: Date }>();

  private key(purpose: string, name: string): string {
    return `${purpose}/${name}`;
  }

  registerPurpose = jest.fn((_purpose: string, _label: string): void => undefined);

  get = jest.fn(async (purpose: string, name: string) => this.rows.get(this.key(purpose, name))?.secret ?? null);

  set = jest.fn(async (purpose: string, name: string, value: string, _actor: string): Promise<void> => {
    this.rows.set(this.key(purpose, name), { secret: value, hint: hintOf(value), updatedAt: new Date() });
  });

  delete = jest.fn(async (purpose: string, name: string, _actor: string): Promise<void> => {
    this.rows.delete(this.key(purpose, name));
  });

  status = jest.fn(async (purpose: string, name: string): Promise<MemoriahubSecretStatus> => {
    const row = this.rows.get(this.key(purpose, name));
    return row
      ? { configured: true, hint: row.hint, updatedAt: row.updatedAt.toISOString() }
      : { configured: false, hint: null, updatedAt: null };
  });

  seed(purpose: string, name: string, secret: string): this {
    this.rows.set(this.key(purpose, name), { secret, hint: hintOf(secret), updatedAt: new Date() });
    return this;
  }
}

function hintOf(secret: string): string {
  return secret.length >= 8 ? `••••${secret.slice(-4)}` : '••••';
}
