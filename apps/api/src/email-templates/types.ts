// =============================================================================
// MemoriaHub email template data (RETRO-D2, #570)
// =============================================================================
//
// The payload each of this app's three templates renders from. The names of
// the templates are PERMANENT (`circle-invitation`, `membership-confirmation`,
// `memory-digest`): they are the keys of the platform template registry and of
// `EmailTemplateDataMap`, augmented in `./index.ts`.
//
// A template is a pure function of this data plus the platform render context
// (product name, URL, layout). It reads no configuration and no clock: every
// absolute URL is built by the caller from `APP_URL`.
// =============================================================================

/** "You've been invited to a circle". */
export interface CircleInvitationEmailData {
  circleName: string;
  inviterName?: string;
  /** Absolute URL of the accept page. */
  acceptUrl: string;
  /** Absolute URL of the decline page, when there is one. */
  declineUrl?: string;
  recipientEmail: string;
}

/** "You've been added to a circle". */
export interface MembershipConfirmationEmailData {
  circleName: string;
  circleDescription?: string;
  /** The per-circle role key (`viewer`, `collaborator`, `circle_admin`). */
  role: string;
  /** Absolute URL of the circle. */
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

/** The per-recipient memories digest. */
export interface MemoryDigestEmailData {
  circleName: string;
  recipientName?: string | null;
  /** Hero first, then up to four more. Never empty: see MemoryDigestService. */
  memories: MemoryDigestItemData[];
  /** Absolute `${APP_URL}/memories` link for the footer CTA. */
  memoriesUrl: string;
  /** Absolute, tokenized, login-free unsubscribe URL. */
  unsubscribeUrl: string;
}
