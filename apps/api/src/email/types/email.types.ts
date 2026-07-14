// =============================================================================
// Email Types
// =============================================================================

/** A fully-rendered, ready-to-send email message. */
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

/** Result of a single send attempt. Never throws — failures are captured here. */
export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** Registered transactional email templates. */
export type EmailTemplateName = 'circle-invitation' | 'membership-confirmation';

/** The rendered pieces a template builder produces. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// -----------------------------------------------------------------------------
// Per-template data payloads
// -----------------------------------------------------------------------------

export interface CircleInvitationEmailData {
  circleName: string;
  inviterName?: string;
  acceptUrl: string;
  declineUrl?: string;
  recipientEmail: string;
}

export interface MembershipConfirmationEmailData {
  circleName: string;
  circleDescription?: string;
  role: string;
  viewUrl: string;
}

/** Maps each template name to its typed data payload. */
export interface EmailTemplateDataMap {
  'circle-invitation': CircleInvitationEmailData;
  'membership-confirmation': MembershipConfirmationEmailData;
}
