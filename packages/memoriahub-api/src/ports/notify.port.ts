// =============================================================================
// MEMORIAHUB_NOTIFY: the notification port (RETRO-J4, #610)
// =============================================================================
//
// Events that tell a user something (uploads finished, a workflow run finished, a queue needs
// review, memories are ready, an email digest). The web edition binds it over the platform
// notifications slice (bell, Web Push, email); a bare host shows an operating-system notification.
// Email is part of this port (an event may carry an email template), as the platform models it.
//
// FOUR WRITE SHAPES, one per kind of event:
//   `notify`        one row per occurrence;
//   `notifyCounted` repeated occurrences fold into ONE row whose count grows (uploads, failures);
//   `notifyState`   at most ONE live row per (user, scope, event), refreshed in place (a review queue);
//   `notifyNow` / `notifyAddress`  the awaited sends: a digest whose caller needs the rate-limit answer,
//                   and a send to an address with no account (an invited email).
//
// EVERY ONE IS DETACHED OR NEVER REJECTS: a slow or broken channel cannot fail the work that raised it.
// Call after the triggering write has committed, never inside a transaction. Event keys and template
// names are persisted: never rename one.
// =============================================================================

/**
 * Injection token of {@link MemoriahubNotifyPort}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_NOTIFY = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_NOTIFY');

/**
 * What an in-app or operating-system notification shows.
 *
 * @stability experimental
 */
export interface MemoriahubBrowserNotification {
  /** The heading. */
  title: string;
  /** The text. */
  body: string;
  /** A root-relative link to open, when there is one. */
  link?: string;
}

/**
 * Declares one notification event.
 *
 * @stability experimental
 */
export interface MemoriahubNotificationEventDef {
  /** The event key (`upload_completed`, `memories.digest`). Persisted; never renamed. */
  key: string;
  /** The name shown in the preferences matrix. */
  label: string;
  /** What triggers it, for the preferences matrix. */
  description: string;
  /** The channels it can use (`browser`, `push`, `email`). */
  channels: readonly string[];
  /** Whether a user who has not chosen receives it. Defaults to true. */
  defaultEnabled?: boolean;
  /** True when the user cannot switch it off. */
  mandatory?: boolean;
  /**
   * How repeated occurrences are stored: `event` (one row each, the default), `counted` (folded into one
   * row whose count grows) or `state` (one live row per user and scope, refreshed in place).
   */
  kind?: 'event' | 'state' | 'counted';
  /** The email template name, when `email` is a channel. */
  emailTemplate?: string;
  /** Renders the in-app / OS notification from the event data. */
  browserTemplate?: (data: never) => MemoriahubBrowserNotification;
}

/**
 * Options of a notification write.
 *
 * @stability experimental
 */
export interface MemoriahubNotifyOptions {
  /** The organization the event belongs to; the host default when absent. */
  orgId?: string | null;
  /** The recipient's time zone, for dates the templates print. */
  timeZone?: string | null;
}

/**
 * Options of {@link MemoriahubNotifyPort.notifyState}.
 *
 * @stability experimental
 */
export interface MemoriahubNotifyStateOptions extends MemoriahubNotifyOptions {
  /** The scope the one live row is keyed by (a library id). */
  scopeId?: string | null;
  /** When a changed count makes a read row unread again: `count-increased` (default) or `never`. */
  reunreadWhen?: 'count-increased' | 'never';
}

/**
 * Options of {@link MemoriahubNotifyPort.notifyCounted}.
 *
 * @stability experimental
 */
export interface MemoriahubNotifyCountedOptions extends MemoriahubNotifyOptions {
  /** The scope the folded row is keyed by (a library id). */
  scopeId?: string | null;
  /** A rolling window anchored on the row's last update; `null` or absent folds without a window. */
  windowMs?: number | null;
  /** Scalar data further partitioning the live row (`{ jobType: 'geocode' }`). */
  match?: Readonly<Record<string, string | number | boolean>>;
  /** How much to add to the row's count; 1 when absent. */
  increment?: number;
}

/**
 * The answer of an awaited send.
 *
 * @stability experimental
 */
export interface MemoriahubNotifyNowResult {
  /** True when a provider throttled the send; the caller defers its job. */
  rateLimited: boolean;
  /** The provider's retry hint, or `null`. */
  retryAfterMs: number | null;
}

/**
 * The renderer helpers an email template is given, so a slice's template never imports an email
 * library. The values are what the host's layout produces.
 *
 * @stability experimental
 */
export interface MemoriahubEmailKit {
  /** What the host calls itself in a subject or a footer. */
  readonly appName: string;
  /** Headers every transactional message carries. */
  readonly headers: Readonly<Record<string, string>>;

  /**
   * Escapes a text for an HTML body.
   *
   * @param text - untrusted text.
   */
  escapeHtml(text: string): string;

  /**
   * Admits a URL only when it is absolute http(s); otherwise `null`.
   *
   * @param url - an untrusted URL.
   */
  safeUrl(url: string): string | null;

  /**
   * Wraps a body in the host's layout.
   *
   * @param opts - the title, the preview text, the body HTML (already escaped) and an optional button.
   * @returns the full HTML document.
   */
  layout(opts: { title: string; previewText?: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string }): string;

  /**
   * The plain-text alternative.
   *
   * @param opts - the title, the lines and an optional button.
   */
  plainText(opts: { title: string; lines: readonly [string, ...string[]]; ctaLabel?: string; ctaUrl?: string }): string;

  /**
   * Formats an instant as a date in a zone.
   *
   * @param date - the instant.
   * @param timeZone - an IANA zone; the host default when absent.
   */
  formatDate(date: Date, timeZone?: string | null): string;

  /**
   * Formats an instant as a date and time in a zone.
   *
   * @param date - the instant.
   * @param timeZone - an IANA zone; the host default when absent.
   */
  formatDateTime(date: Date, timeZone?: string | null): string;
}

/**
 * A rendered message.
 *
 * @stability experimental
 */
export interface MemoriahubRenderedEmail {
  /** The subject line. */
  subject: string;
  /** The HTML body. */
  html: string;
  /** The plain-text body. */
  text: string;
  /** Extra headers. */
  headers?: Record<string, string>;
}

/**
 * An email template a slice registers by name.
 *
 * @stability experimental
 */
export interface MemoriahubEmailTemplateDef {
  /** The template name. Persisted in delivery records; never renamed. */
  name: string;
  /**
   * Renders the message.
   *
   * @param data - the event data.
   * @param kit - the host's layout helpers.
   */
  render(data: never, kit: MemoriahubEmailKit): MemoriahubRenderedEmail;
}

/**
 * A live state row: the recipient, the event and the scope it is about.
 *
 * @stability experimental
 */
export interface MemoriahubLiveStateRow {
  /** The recipient. */
  userId: string;
  /** The event key. */
  eventKey: string;
  /** The scope the row is about, or `null` for a deployment-wide one. */
  scopeId: string | null;
}

/**
 * The notification port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubNotifyPort {
  /**
   * Declares events. Idempotent per key; call it at import or start-up time, before the host freezes
   * its registries.
   *
   * @param defs - the events.
   */
  registerEvents(defs: readonly MemoriahubNotificationEventDef[]): void;

  /**
   * Declares email templates. Idempotent per name; same timing rule as `registerEvents`.
   *
   * @param defs - the templates.
   */
  registerEmailTemplates(defs: readonly MemoriahubEmailTemplateDef[]): void;

  /**
   * Raises an event for a user, one row per occurrence. Returns immediately; delivery is detached and
   * a failure is logged, never thrown.
   *
   * @param eventKey - a registered event key.
   * @param userId - the recipient.
   * @param data - the event data the templates render.
   * @param options - the organization and the time zone.
   */
  notify(eventKey: string, userId: string, data: unknown, options?: MemoriahubNotifyOptions): void;

  /**
   * Folds an occurrence into ONE counted row (optionally inside a rolling window). Detached; never throws.
   *
   * @param eventKey - a registered event key.
   * @param userId - the recipient.
   * @param data - the event data; its scalar fields are stored on the row.
   * @param options - the scope, the window, the partition and the increment.
   */
  notifyCounted(
    eventKey: string,
    userId: string,
    data: Record<string, unknown>,
    options?: MemoriahubNotifyCountedOptions,
  ): void;

  /**
   * Writes the ONE live state row of (user, scope, event), refreshed in place. Detached; never throws.
   *
   * @param eventKey - a registered event key.
   * @param userId - the recipient.
   * @param data - the state; `count` is the queue depth (0 dismisses the row).
   * @param options - the scope and the re-unread rule.
   */
  notifyState(
    eventKey: string,
    userId: string,
    data: { count: number } & Record<string, unknown>,
    options?: MemoriahubNotifyStateOptions,
  ): void;

  /**
   * The live (not dismissed) state rows of the given events, optionally in one scope: who still has a
   * row to drain. Optional: a host that cannot list them binds `notifyState` alone, and a reconcile
   * then writes the current counts but cannot drain the rows of a queue that went away.
   *
   * @param eventKeys - the state events.
   * @param scopeId - one scope, or every scope when absent.
   */
  liveStates?(eventKeys: readonly string[], scopeId?: string): Promise<MemoriahubLiveStateRow[]>;

  /**
   * The awaited sibling of `notify`, for a background path that must know whether the send was
   * rate-limited (a digest). Never rejects.
   *
   * @param eventKey - a registered event key.
   * @param userId - the recipient.
   * @param data - the event data.
   * @param options - the organization and the time zone.
   */
  notifyNow(
    eventKey: string,
    userId: string,
    data: unknown,
    options?: MemoriahubNotifyOptions,
  ): Promise<MemoriahubNotifyNowResult>;

  /**
   * Sends an event to an email address that has no account (an invited address). Detached; never throws.
   *
   * @param eventKey - a registered event key with the `email` channel.
   * @param email - the address.
   * @param data - the event data.
   * @param options - the organization and the time zone.
   */
  notifyAddress(eventKey: string, email: string, data: unknown, options?: MemoriahubNotifyOptions): void;
}
