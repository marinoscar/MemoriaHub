// PLATFORM-ADOPTION-SHIM(RETRO-D2): the LEGACY `email.*` block of the `global` row, kept read-only
// for rollback. Since RETRO-D2 (#570) nothing sends with it: the platform email slice reads its own
// `email` row of `system_settings` plus the credential store (`smtp/default`, `email_ses/default`),
// written once from this block by `scripts/migrate-email-settings.ts` and from then on by
// `PUT /api/email-settings`. It stays registered so the stored values (and the inline-encrypted
// `smtpPassword`, which this namespace never declares, so it is never returned or accepted) survive
// every settings write until a later cleanup release removes the key. A write to it through the
// generic settings route changes nothing that sends mail.
import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  provider: z.enum(['ses', 'smtp']).nullable(),
  enabled: z.boolean(),
  sesRegion: z.string().nullable(),
  smtpHost: z.string().nullable(),
  smtpPort: z.number().int().min(1).max(65535),
  smtpUseTls: z.boolean(),
  smtpUsername: z.string().nullable(),
  fromAddress: z.string().nullable(),
  fromName: z.string().nullable(),
});
export type EmailSettingsValue = z.infer<typeof schema>;

/** The `email.*` block seeded from environment variables (the password excepted: see above). */
export function defaultEmailSettings(): EmailSettingsValue {
  const envProvider = process.env['EMAIL_PROVIDER'];
  const smtpPortRaw = process.env['SMTP_PORT'];
  const smtpUseTlsRaw = process.env['SMTP_USE_TLS'];
  return {
    provider: envProvider === 'ses' || envProvider === 'smtp' ? envProvider : null,
    enabled: false,
    sesRegion: process.env['AWS_SES_REGION'] ?? null,
    smtpHost: process.env['SMTP_HOST'] ?? null,
    smtpPort: smtpPortRaw && !isNaN(parseInt(smtpPortRaw, 10)) ? parseInt(smtpPortRaw, 10) : 587,
    smtpUseTls: smtpUseTlsRaw ? smtpUseTlsRaw !== 'false' : true,
    smtpUsername: process.env['SMTP_USERNAME'] ?? null,
    fromAddress: process.env['EMAIL_FROM_ADDRESS'] ?? null,
    fromName: process.env['EMAIL_FROM_NAME'] ?? null,
  };
}

export const EMAIL_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'email',
  description: 'Transactional email: provider (SES or SMTP), sender identity and SMTP connection (never the password).',
  schema,
  defaults: defaultEmailSettings(),
});
