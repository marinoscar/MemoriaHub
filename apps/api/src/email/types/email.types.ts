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
  /**
   * Extra RFC 5322 headers, passed through to the provider verbatim.
   *
   * Added for the Memories digest's `List-Unsubscribe` /
   * `List-Unsubscribe-Post` pair (issue #311), which are per-RECIPIENT (the
   * unsubscribe token embeds the user id) and therefore cannot live in a
   * provider-level configuration.
   */
  headers?: Record<string, string>;
}

/** Result of a single send attempt. Never throws — failures are captured here. */
export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** Registered transactional email templates. */
export type EmailTemplateName =
  | 'circle-invitation'
  | 'membership-confirmation'
  | 'memory-digest';

/** The rendered pieces a template builder produces. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Optional per-message headers (e.g. `List-Unsubscribe`). */
  headers?: Record<string, string>;
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

/**
 * One curated memory as rendered in the digest email (epic #300, issue #311).
 *
 * `imageUrl` is an absolute, HMAC-signed public URL (see digest-token.util.ts)
 * rather than a signed storage URL: storage signatures expire in 24h, which is
 * useless for something that sits in an inbox. `null` when the memory has no
 * usable cover, in which case the template renders a text-only card.
 */
export interface MemoryDigestItemData {
  id: string;
  /** `MemoryType` value, used for the coloured type chip. */
  type: string;
  /** Human label for the chip, e.g. "On this day". */
  typeLabel: string;
  title: string;
  subtitle?: string | null;
  /** AI-written blurb, hero card only. */
  narrative?: string | null;
  itemCount: number;
  imageUrl?: string | null;
  /** Absolute `${APP_URL}/memories/{id}` link. */
  url: string;
}

export interface MemoryDigestEmailData {
  circleName: string;
  recipientName?: string | null;
  /** Hero first, then up to four more. Never empty — see MemoryDigestService. */
  memories: MemoryDigestItemData[];
  /** Absolute `${APP_URL}/memories` link for the footer CTA. */
  memoriesUrl: string;
  /** Absolute, tokenized, login-free unsubscribe URL. */
  unsubscribeUrl: string;
}

/** Maps each template name to its typed data payload. */
export interface EmailTemplateDataMap {
  'circle-invitation': CircleInvitationEmailData;
  'membership-confirmation': MembershipConfirmationEmailData;
  'memory-digest': MemoryDigestEmailData;
}
