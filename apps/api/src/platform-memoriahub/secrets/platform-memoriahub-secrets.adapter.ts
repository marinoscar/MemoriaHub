import { Injectable } from '@nestjs/common';
import {
  CredentialsService,
  credentialPurposeRegistry,
  registerCredentialPurpose,
} from '@marinoscar/platform-api/credentials';
import { Trace } from '@marinoscar/platform-api/otel-core';
import type { MemoriahubSecretStatus, MemoriahubSecretsPort } from '@marinoscar/memoriahub-api/ports';

// =============================================================================
// PlatformMemoriahubSecretsAdapter: the `MEMORIAHUB_SECRETS` port over the platform credential store
// (RETRO-J4, #610)
// =============================================================================
//
// Secrets are the platform's encrypted (purpose, name) rows (AES-256-GCM with `SECRETS_ENCRYPTION_KEY`).
// MemoriaHub's purposes (`geo_provider`, `face_compreface`, ...) are declared in
// `platform/credentials/credential-purposes.manifest.ts` before the application starts; `registerPurpose`
// here only adds one a slice brings that is not there yet. `status` never returns material.
// =============================================================================

/** The owner recorded for a purpose registered through the port. */
const OWNER = 'memoriahub';

@Injectable()
export class PlatformMemoriahubSecretsAdapter implements MemoriahubSecretsPort {
  constructor(private readonly credentials: CredentialsService) {}

  registerPurpose(purpose: string, label: string): void {
    if (credentialPurposeRegistry.has(purpose)) return;

    registerCredentialPurpose({ purpose, owner: OWNER, label, tiers: ['system'] });
  }

  @Trace()
  get(purpose: string, name: string): Promise<string | null> {
    return this.credentials.getSecret(purpose, name);
  }

  @Trace()
  async set(purpose: string, name: string, value: string, actorUserId: string): Promise<void> {
    await this.credentials.setSecret(purpose, name, value, { updatedByUserId: actorUserId });
  }

  @Trace()
  async delete(purpose: string, name: string, _actorUserId: string): Promise<void> {
    await this.credentials.deleteSecret(purpose, name);
  }

  @Trace()
  async status(purpose: string, name: string): Promise<MemoriahubSecretStatus> {
    const info = await this.credentials.describe(purpose, name);
    if (!info) return { configured: false, hint: null, updatedAt: null };

    return { configured: true, hint: info.hint, updatedAt: info.updatedAt.toISOString() };
  }
}
