// =============================================================================
// The SMTP password's home until the credential store (RETRO-B3, #614)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(RETRO-D2): the email slice moves the password into the encrypted
// credential store (RETRO-B4), and this file goes.
//
// The AES-256-GCM ciphertext lives where it always did, at `email.smtpPassword` inside the `global`
// `system_settings` row, so no row is rewritten. The `email` system namespace does NOT declare the
// field, which is what keeps it out of every response and every request body: the platform settings
// service never returns a key its namespace does not model, never accepts one, and carries it
// forward untouched on every write. This store is the only reader and writer. The value is
// ciphertext only; plaintext exists in memory for the length of one `decryptSecret` call.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

const SETTINGS_KEY = 'global';
const CACHE_TTL_MS = 5000;

@Injectable()
export class EmailSmtpSecretStore {
  private cache: { value: string | null; at: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** The stored ciphertext, or null when none was ever saved. Cached for 5 s. */
  async getCiphertext(): Promise<string | null> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;

    const row = await this.prisma.systemSettings.findUnique({
      where: { key: SETTINGS_KEY },
      select: { value: true },
    });
    const email = (row?.value as { email?: { smtpPassword?: unknown } } | null | undefined)?.email;
    const value = typeof email?.smtpPassword === 'string' && email.smtpPassword ? email.smtpPassword : null;

    this.cache = { value, at: Date.now() };
    return value;
  }

  /**
   * Store a new ciphertext, atomically (one `jsonb_set`, so a concurrent write of another key of
   * the row is not lost), bump the row version and audit the change without the value.
   */
  async setCiphertext(ciphertext: string, actorUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE system_settings
        SET value = jsonb_set(
              value,
              '{email}',
              COALESCE(value->'email', '{}'::jsonb) || jsonb_build_object('smtpPassword', ${ciphertext}::text),
              true
            ),
            version = version + 1,
            updated_by_user_id = ${actorUserId}::uuid,
            updated_at = now()
        WHERE key = ${SETTINGS_KEY}
        RETURNING id::text AS id
      `);
      const target = updated[0];
      if (!target) throw new Error('The system settings row does not exist yet');

      await tx.auditEvent.create({
        data: {
          actorUserId,
          action: 'system_settings:email_smtp_password',
          targetType: 'system_settings',
          targetId: target.id,
          meta: { changed: 'email.smtpPassword' },
        },
      });
    });
    this.cache = null;
  }
}
