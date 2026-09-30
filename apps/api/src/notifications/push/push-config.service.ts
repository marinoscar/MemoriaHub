import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as webpush from 'web-push';

import { decryptSecret, encryptSecret } from '../../common/crypto/secret-cipher';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_VAPID_SUBJECT,
  EMPTY_PUSH_CONFIG,
  PUSH_CONFIG_KEY,
  StoredPushConfig,
  storedPushConfigSchema,
} from './push-config.schema';
import type {
  GeneratePushConfigInput,
  PushConfigAdminView,
  RemovePushConfigInput,
  RotatePushConfigInput,
  UpdatePushConfigInput,
} from './dto/push-config.dto';

// =============================================================================
// PushConfigService — runtime-configured Web Push VAPID keys (epic #481, #483)
// =============================================================================
//
// Ported from EnterpriseAppBase's PushConfigService with ONE structural
// difference: MemoriaHub has no generic credential store, so the private key
// lives AES-256-GCM encrypted (`encryptSecret`) inside the same `webPush`
// system_settings row as the public key — exactly how `email.smtpPassword` is
// stored. It never leaves this service except as the plaintext handed to a
// sender at the moment it signs a push (`resolveActiveVapidConfig`).
//
// ACTIVE-CONFIG PRECEDENCE (resolveActiveVapidConfig) — no env fallback:
//   1. No row                          -> null (not configured)
//   2. Row invalid                     -> null, logged loudly
//   3. enabled: false                  -> null
//   4. enabled, but a key half missing
//      or the ciphertext undecryptable -> null, logged loudly
//   5. otherwise                       -> { publicKey, privateKey, subject }
//
// Reads go straight through PrismaService (NotificationsModule imports nothing
// — see notifications.module.ts), never through SystemSettingsService, which
// only ever reads the `global` row anyway.
// =============================================================================

/** What a sender needs to sign a push. Never rendered to any client. */
export interface ActiveVapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

type StoredRow = { value: Prisma.JsonValue } | null;

@Injectable()
export class PushConfigService {
  private readonly logger = new Logger(PushConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------------------

  /** Everything GET /api/admin/push-config renders. Never throws on a bad row. */
  async describeForAdmin(): Promise<PushConfigAdminView> {
    const row = await this.readRow();
    if (!row) return this.toAdminView(EMPTY_PUSH_CONFIG, null);

    const parsed = storedPushConfigSchema.safeParse(row.value);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
      this.logger.error(`Stored Web Push settings are invalid at: ${paths}`);
      return this.toAdminView(
        EMPTY_PUSH_CONFIG,
        `The stored Web Push configuration is invalid at: ${paths}. Generate or remove it to repair.`,
      );
    }
    return this.toAdminView(parsed.data, null);
  }

  /**
   * THE one place every sender asks "which VAPID key pair, if any, is active".
   * `null` uniformly means "push is off"; callers need not know why.
   */
  async resolveActiveVapidConfig(): Promise<ActiveVapidConfig | null> {
    let row: StoredRow;
    try {
      row = await this.readRow();
    } catch (err) {
      this.logger.warn(
        `Web Push config read failed; treating push as off: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!row) return null;

    const parsed = storedPushConfigSchema.safeParse(row.value);
    if (!parsed.success) {
      this.logger.error('Stored Web Push settings are invalid; push is disabled until repaired.');
      return null;
    }
    const settings = parsed.data;
    if (!settings.enabled) return null;

    if (!settings.publicKey || !settings.privateKeyEncrypted) {
      this.logger.warn(
        'Web Push is enabled but its key pair is incomplete; treating it as disabled until repaired.',
      );
      return null;
    }

    let privateKey: string;
    try {
      privateKey = decryptSecret(settings.privateKeyEncrypted);
    } catch {
      // Wrong SECRETS_ENCRYPTION_KEY, or a corrupted ciphertext. Never fall
      // back to anything — push is simply off until an admin rotates.
      this.logger.error(
        'Web Push private key could not be decrypted (SECRETS_ENCRYPTION_KEY changed?); push is disabled until the keys are rotated.',
      );
      return null;
    }

    return {
      publicKey: settings.publicKey,
      privateKey,
      subject: settings.subject || DEFAULT_VAPID_SUBJECT,
    };
  }

  /**
   * The public key a browser needs for `pushManager.subscribe`, or null when
   * push is not active right now.
   */
  async getActivePublicKey(): Promise<string | null> {
    return (await this.resolveActiveVapidConfig())?.publicKey ?? null;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * First-time key generation. 409 when ANY key half already exists —
   * replacing a live pair silently would strand every subscriber; that
   * destructive act is `rotate`'s job, behind a typed confirmation.
   * Enables push: generating keys is, by that action, asking for it on.
   */
  async generate(input: GeneratePushConfigInput, userId: string): Promise<PushConfigAdminView> {
    const current = this.parse(await this.readRow());
    if (current && (current.publicKey || current.privateKeyEncrypted)) {
      throw new ConflictException(
        'Web Push is already configured. Use the rotate action to replace the existing keys.',
      );
    }

    const next = this.withNewKeys(
      { ...EMPTY_PUSH_CONFIG, enabled: true, subject: input.subject ?? null },
      userId,
    );
    await this.writeRow(next, userId);
    await this.audit(userId, 'push_config:generate', { enabled: next.enabled, subject: next.subject });
    this.logger.log(`Web Push VAPID keys generated by user ${userId}`);
    return this.toAdminView(next, null);
  }

  /**
   * Replace the key pair. 409 when nothing is configured yet (use generate).
   * Keeps `enabled` as it was; `subject` replaced only when provided.
   * Disruptive: every existing subscription stops receiving pushes until its
   * browser re-subscribes against the new public key.
   */
  async rotate(input: RotatePushConfigInput, userId: string): Promise<PushConfigAdminView> {
    const current = this.parse(await this.readRow());
    if (!current || !current.publicKey || !current.privateKeyEncrypted) {
      throw new ConflictException(
        'Web Push has not been configured yet. Use the generate action to create the first key pair.',
      );
    }

    const next = this.withNewKeys(
      {
        ...current,
        subject: input.subject !== undefined ? input.subject : current.subject,
      },
      userId,
    );
    await this.writeRow(next, userId);
    await this.audit(userId, 'push_config:rotate', { enabled: next.enabled, subject: next.subject });
    this.logger.log(`Web Push VAPID keys rotated by user ${userId}`);
    return this.toAdminView(next, null);
  }

  /**
   * Partial update of `{ enabled, subject }`. Flips the switch; never mints
   * keys — enabling with no key pair is a 409 (generate first). Disabling is
   * always allowed and retains the keys.
   */
  async update(input: UpdatePushConfigInput, userId: string): Promise<PushConfigAdminView> {
    const current = this.parse(await this.readRow()) ?? EMPTY_PUSH_CONFIG;

    const enabled = input.enabled ?? current.enabled;
    if (enabled && (!current.publicKey || !current.privateKeyEncrypted)) {
      throw new ConflictException(
        'Cannot enable Web Push before a key pair has been generated. Use the generate action first.',
      );
    }

    const next: StoredPushConfig = {
      ...current,
      enabled,
      subject: input.subject !== undefined ? input.subject : current.subject,
      updatedAt: new Date().toISOString(),
      updatedById: userId,
    };
    await this.writeRow(next, userId);
    await this.audit(userId, 'push_config:update', { enabled: next.enabled, subject: next.subject });
    this.logger.log(`Web Push settings updated by user ${userId} (enabled: ${next.enabled})`);
    return this.toAdminView(next, null);
  }

  /** Remove the configuration outright (row and keys). Returns the empty view. */
  async remove(_input: RemovePushConfigInput, userId: string): Promise<PushConfigAdminView> {
    const { count } = await this.prisma.systemSettings.deleteMany({
      where: { key: PUSH_CONFIG_KEY },
    });
    if (count > 0) {
      await this.audit(userId, 'push_config:remove', {});
    }
    this.logger.log(`Web Push configuration removed by user ${userId}`);
    return this.toAdminView(EMPTY_PUSH_CONFIG, null);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private readRow(): Promise<StoredRow> {
    return this.prisma.systemSettings.findUnique({
      where: { key: PUSH_CONFIG_KEY },
      select: { value: true },
    });
  }

  private parse(row: StoredRow): StoredPushConfig | null {
    if (!row) return null;
    const parsed = storedPushConfigSchema.safeParse(row.value);
    return parsed.success ? parsed.data : null;
  }

  private withNewKeys(base: StoredPushConfig, userId: string): StoredPushConfig {
    const keys = webpush.generateVAPIDKeys();
    return {
      ...base,
      publicKey: keys.publicKey,
      privateKeyEncrypted: encryptSecret(keys.privateKey),
      privateKeyLast4: keys.privateKey.slice(-4),
      updatedAt: new Date().toISOString(),
      updatedById: userId,
    };
  }

  private async writeRow(settings: StoredPushConfig, userId: string): Promise<void> {
    const value = settings as unknown as Prisma.InputJsonValue;
    await this.prisma.systemSettings.upsert({
      where: { key: PUSH_CONFIG_KEY },
      update: { value, updatedByUserId: userId, version: { increment: 1 } },
      create: { key: PUSH_CONFIG_KEY, value, updatedByUserId: userId },
    });
  }

  /**
   * Audit row. `meta` carries only `enabled`/`subject` — never a key, public
   * or private. Best-effort: an audit failure must not fail a completed write.
   */
  private async audit(
    userId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action,
          targetType: 'system_settings',
          targetId: PUSH_CONFIG_KEY,
          meta: meta as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Could not record audit event ${action}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private toAdminView(
    settings: StoredPushConfig,
    settingsError: string | null,
  ): PushConfigAdminView {
    const privateConfigured = Boolean(settings.privateKeyEncrypted);
    const configured = Boolean(settings.publicKey) && privateConfigured;
    return {
      enabled: settings.enabled,
      publicKey: settings.publicKey,
      subject: settings.subject,
      effectiveSubject: settings.subject || DEFAULT_VAPID_SUBJECT,
      configured,
      active: settings.enabled && configured,
      privateKeyStatus: {
        configured: privateConfigured,
        last4: privateConfigured ? settings.privateKeyLast4 : null,
        updatedAt: privateConfigured ? settings.updatedAt : null,
      },
      settingsError,
      updatedAt: settings.updatedAt,
      updatedById: settings.updatedById,
    };
  }
}
