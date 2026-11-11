// =============================================================================
// An in-memory secrets port with the credential store's masked hint, for the geo specs
// =============================================================================
//
// The geo administration reports `last4` from the hint the store keeps (`••••1234`; fully masked `••••`
// for a secret shorter than eight characters). `FakeMemoriahubSecrets` of the testing entry keeps the
// last four characters instead, so the specs of the code that moved out of the web app use this double,
// which has the real masking, records every write in `calls`, and has no purpose registration step.
// =============================================================================

import type { MemoriahubSecretStatus, MemoriahubSecretsPort } from '../../src/ports/index.js';

const MASK = '••••';

function deriveHint(secret: string): string {
  const points = Array.from(secret);
  return points.length < 8 ? MASK : `${MASK}${points.slice(-4).join('')}`;
}

/** The secrets port over a Map; the jest.fn members record how it was called. */
export class FakeGeoSecrets implements MemoriahubSecretsPort {
  readonly rows = new Map<string, { secret: string; hint: string }>();

  readonly calls: string[] = [];

  private key(purpose: string, name: string): string {
    return `${purpose}/${name}`;
  }

  registerPurpose = jest.fn();

  get = jest.fn(async (purpose: string, name: string) => this.rows.get(this.key(purpose, name))?.secret ?? null);

  set = jest.fn(async (purpose: string, name: string, value: string, _actorUserId: string) => {
    this.calls.push(`set:${purpose}/${name}`);
    this.rows.set(this.key(purpose, name), { secret: value, hint: deriveHint(value) });
  });

  delete = jest.fn(async (purpose: string, name: string, _actorUserId: string) => {
    this.calls.push(`delete:${purpose}/${name}`);
    this.rows.delete(this.key(purpose, name));
  });

  status = jest.fn(async (purpose: string, name: string): Promise<MemoriahubSecretStatus> => {
    const row = this.rows.get(this.key(purpose, name));
    return row ? { configured: true, hint: row.hint, updatedAt: new Date().toISOString() } : { configured: false, hint: null, updatedAt: null };
  });

  /** Stores a secret without recording a call. */
  seed(purpose: string, name: string, secret: string): this {
    this.rows.set(this.key(purpose, name), { secret, hint: deriveHint(secret) });
    return this;
  }
}
