import type {
  MemoriahubEmailTemplateDef,
  MemoriahubNotificationEventDef,
  MemoriahubNotifyCountedOptions,
  MemoriahubNotifyNowResult,
  MemoriahubNotifyOptions,
  MemoriahubNotifyPort,
  MemoriahubNotifyStateOptions,
} from '../ports/index.js';

/**
 * One notification write a {@link FakeMemoriahubNotify} recorded.
 *
 * @stability experimental
 */
export interface FakeNotification {
  /** Which method. */
  method: 'notify' | 'notifyCounted' | 'notifyState' | 'notifyNow' | 'notifyAddress';
  /** The event key. */
  eventKey: string;
  /** The recipient: a user id, or an email address for `notifyAddress`. */
  to: string;
  /** The data. */
  data: unknown;
}

/**
 * A recording `MEMORIAHUB_NOTIFY`. Writes to an unregistered event are dropped (and counted in `dropped`),
 * never thrown, like the platform's; `notifyCounted` folds into one row per (user, scope, event, match)
 * and `notifyState` keeps one live row per (user, scope, event).
 *
 * @stability experimental
 */
export class FakeMemoriahubNotify implements MemoriahubNotifyPort {
  /** Registered events, by key. */
  readonly events = new Map<string, MemoriahubNotificationEventDef>();

  /** Registered templates, by name. */
  readonly templates = new Map<string, MemoriahubEmailTemplateDef>();

  /** Every write, in order. */
  readonly sent: FakeNotification[] = [];

  /** The folded counted rows: key -> count. */
  readonly counted = new Map<string, number>();

  /** The live state rows: key -> data. */
  readonly state = new Map<string, { count: number } & Record<string, unknown>>();

  /** How many writes named an unregistered event. */
  dropped = 0;

  /** What `notifyNow` answers. */
  nowResult: MemoriahubNotifyNowResult = { rateLimited: false, retryAfterMs: null };

  /** Declares events. */
  registerEvents(defs: readonly MemoriahubNotificationEventDef[]): void {
    for (const def of defs) if (!this.events.has(def.key)) this.events.set(def.key, def);
  }

  /** Declares templates. */
  registerEmailTemplates(defs: readonly MemoriahubEmailTemplateDef[]): void {
    for (const def of defs) if (!this.templates.has(def.name)) this.templates.set(def.name, def);
  }

  /** One row per occurrence. */
  notify(eventKey: string, userId: string, data: unknown, _options?: MemoriahubNotifyOptions): void {
    this.record('notify', eventKey, userId, data);
  }

  /** Folds into one counted row. */
  notifyCounted(eventKey: string, userId: string, data: Record<string, unknown>, options?: MemoriahubNotifyCountedOptions): void {
    if (!this.record('notifyCounted', eventKey, userId, data)) return;
    const key = JSON.stringify([eventKey, userId, options?.scopeId ?? null, options?.match ?? null]);
    this.counted.set(key, (this.counted.get(key) ?? 0) + (options?.increment ?? 1));
  }

  /** Keeps one live state row. */
  notifyState(eventKey: string, userId: string, data: { count: number } & Record<string, unknown>, options?: MemoriahubNotifyStateOptions): void {
    if (!this.record('notifyState', eventKey, userId, data)) return;
    const key = JSON.stringify([eventKey, userId, options?.scopeId ?? null]);
    if (data.count <= 0) this.state.delete(key);
    else this.state.set(key, data);
  }

  /** Whether a recorded write of the event to the user carried every `match` value in its data. */
  async hasNotified(eventKey: string, userId: string, match: Readonly<Record<string, string | number | boolean>>): Promise<boolean> {
    return this.sent.some((n) => {
      if (n.eventKey !== eventKey || n.to !== userId) return false;
      const data = (n.data ?? {}) as Record<string, unknown>;
      return Object.entries(match).every(([k, v]) => data[k] === v);
    });
  }

  /** Awaited send. */
  async notifyNow(eventKey: string, userId: string, data: unknown, _options?: MemoriahubNotifyOptions): Promise<MemoriahubNotifyNowResult> {
    this.record('notifyNow', eventKey, userId, data);
    return this.nowResult;
  }

  /** Send to an address. */
  notifyAddress(eventKey: string, email: string, data: unknown, _options?: MemoriahubNotifyOptions): void {
    this.record('notifyAddress', eventKey, email, data);
  }

  private record(method: FakeNotification['method'], eventKey: string, to: string, data: unknown): boolean {
    if (!this.events.has(eventKey)) {
      this.dropped += 1;
      return false;
    }
    this.sent.push({ method, eventKey, to, data });
    return true;
  }
}
