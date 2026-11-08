// PLATFORM-ADOPTION-SHIM(RETRO-D2): the email slice swaps this for the platform namespace; the SMTP
// password moves to the credential store (RETRO-B4).
//
// `smtpPassword` is NOT part of this namespace. The AES-256-GCM ciphertext stays in the same
// `email` object of the `global` row, but as a key the namespace does not know: the platform
// service carries unmodelled keys forward on every write, never returns them from GET and never
// accepts them from a PATCH or PUT body. That is the redaction. The only reader and writer is
// `EmailSmtpSecretStore`.
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
