import { deriveHint } from '@marinoscar/platform-api/credentials';

/**
 * An in-memory stand-in for the platform `CredentialsService` (RETRO-B4, #617): the same
 * (purpose, name) addressing, blank-preserves rule and masked hint, without a database.
 * It stores plaintext on purpose (it is a test double), and `calls` records every write so a test
 * can assert that nothing but the credential store ever saw a secret.
 */
export class FakeCredentials {
  readonly rows = new Map<string, { secret: string; hint: string; updatedByUserId: string | null; updatedAt: Date }>();
  readonly calls: string[] = [];

  private key(purpose: string, name: string): string {
    return `${purpose}/${name}`;
  }

  getSecret = jest.fn(async (purpose: string, name: string) => this.rows.get(this.key(purpose, name))?.secret ?? null);

  describe = jest.fn(async (purpose: string, name: string) => {
    const row = this.rows.get(this.key(purpose, name));
    return row
      ? {
          purpose,
          name,
          hint: row.hint,
          label: null,
          updatedByUserId: row.updatedByUserId,
          createdAt: row.updatedAt,
          updatedAt: row.updatedAt,
        }
      : null;
  });

  setSecret = jest.fn(
    async (purpose: string, name: string, secret: string | null | undefined, meta?: { updatedByUserId?: string | null }) => {
      this.calls.push(`set:${purpose}/${name}`);
      const existing = this.rows.get(this.key(purpose, name));
      if (!secret) {
        if (!existing) throw new Error('blank first write');
        return;
      }
      this.rows.set(this.key(purpose, name), {
        secret,
        hint: deriveHint(secret),
        updatedByUserId: meta?.updatedByUserId ?? null,
        updatedAt: new Date(),
      });
    },
  );

  deleteSecret = jest.fn(async (purpose: string, name: string) => {
    this.calls.push(`delete:${purpose}/${name}`);
    return this.rows.delete(this.key(purpose, name));
  });

  list = jest.fn(async () => []);

  seed(purpose: string, name: string, secret: string): this {
    this.rows.set(this.key(purpose, name), { secret, hint: deriveHint(secret), updatedByUserId: null, updatedAt: new Date() });
    return this;
  }
}
