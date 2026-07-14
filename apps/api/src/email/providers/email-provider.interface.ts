import { EmailMessage, EmailSendResult } from '../types/email.types';

/**
 * A concrete email transport (SES, SMTP, ...). Implementations MUST NOT throw
 * from `send` — any failure is returned as `{ success: false, error }`.
 */
export interface EmailProvider {
  send(msg: EmailMessage): Promise<EmailSendResult>;
}
