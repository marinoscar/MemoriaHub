import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailProvider = 'ses' | 'smtp';

export type EmailCredentialSource = 'ses:reuses-s3' | 'smtp:inline';

export interface EmailSmtpSettings {
  host: string | null;
  port: number;
  useTls: boolean;
  username: string | null;
  passwordConfigured: boolean;
  passwordLast4: string | null;
}

export interface EmailSettings {
  provider: EmailProvider | null;
  enabled: boolean;
  fromAddress: string | null;
  fromName: string | null;
  sesRegion: string | null;
  sesCredentialAvailable: boolean;
  smtp: EmailSmtpSettings;
  credentialSource: EmailCredentialSource | null;
}

export interface UpdateEmailSettingsBody {
  provider: EmailProvider;
  enabled: boolean;
  sesRegion?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUseTls?: boolean;
  smtpUsername?: string;
  // Send only when a new password was typed; omit/blank preserves the stored one.
  smtpPassword?: string;
  fromAddress?: string;
  fromName?: string;
}

export interface TestEmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getEmailSettings(): Promise<EmailSettings> {
  return api.get<EmailSettings>('/email-settings');
}

export async function updateEmailSettings(
  body: UpdateEmailSettingsBody,
): Promise<EmailSettings> {
  return api.put<EmailSettings>('/email-settings', body);
}

export async function testEmail(recipient: string): Promise<TestEmailResult> {
  return api.post<TestEmailResult>('/email-settings/test', { recipient });
}
