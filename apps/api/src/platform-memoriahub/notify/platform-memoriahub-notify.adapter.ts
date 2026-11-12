import { Injectable, Logger } from '@nestjs/common';
import {
  emailTemplateRegistry,
  escapeHtml,
  formatEmailDate,
  formatEmailDateTime,
  plainText,
  registerEmailTemplates,
  renderLayout,
  resolveEmailRenderContext,
  safeUrl,
  SafeHtml,
  TRANSACTIONAL_EMAIL_HEADERS,
  type EmailRenderContext,
} from '@marinoscar/platform-api/email';
import {
  NotificationsService,
  findEvent,
  registerNotification,
  type NotificationChannel,
  type NotificationRegistration,
} from '@marinoscar/platform-api/notifications';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  MemoriahubEmailKit,
  MemoriahubLiveStateRow,
  MemoriahubEmailTemplateDef,
  MemoriahubNotificationEventDef,
  MemoriahubNotifyCountedOptions,
  MemoriahubNotifyNowResult,
  MemoriahubNotifyOptions,
  MemoriahubNotifyPort,
  MemoriahubNotifyStateOptions,
} from '@marinoscar/memoriahub-api/ports';

// =============================================================================
// PlatformMemoriahubNotifyAdapter: the `MEMORIAHUB_NOTIFY` port over the platform notifications slice
// (RETRO-J4, #610)
// =============================================================================
//
// `registerEvents` declares an event with `registerNotification` (idempotent per key: MemoriaHub's own events
// are registered at import time by `notifications-registry/`, so a slice that declares one again finds it
// and registers nothing twice). `registerEmailTemplates` does the same for the email registry, bridging a
// slice's host-neutral `render(data, kit)` to the platform's `(data, ctx)` template by building the kit from
// the platform layout.
//
// THE WRITES ARE DETACHED. `notify`, `notifyCounted`, `notifyState` and `notifyAddress` return before
// delivery and never throw (the platform's own methods never reject; this adapter catches anyway, so a
// binding fault cannot fail the work that raised the event). `notifyNow` is the awaited sibling and never
// rejects either. Call after the triggering write has committed, outside any transaction.
// =============================================================================

@Injectable()
export class PlatformMemoriahubNotifyAdapter implements MemoriahubNotifyPort {
  private readonly logger = new Logger(PlatformMemoriahubNotifyAdapter.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  registerEvents(defs: readonly MemoriahubNotificationEventDef[]): void {
    for (const def of defs) {
      if (findEvent(def.key)) continue;

      const registration: NotificationRegistration = {
        event: {
          key: def.key,
          label: def.label,
          description: def.description,
          channels: [...def.channels] as NotificationChannel[],
          defaultEnabled: def.defaultEnabled ?? true,
          ...(def.mandatory !== undefined ? { mandatory: def.mandatory } : {}),
          ...(def.kind !== undefined ? { kind: def.kind } : {}),
        },
        ...(def.emailTemplate !== undefined ? { emailTemplate: def.emailTemplate } : {}),
        ...(def.browserTemplate !== undefined ? { browserTemplate: def.browserTemplate } : {}),
      };
      registerNotification(registration);
    }
  }

  registerEmailTemplates(defs: readonly MemoriahubEmailTemplateDef[]): void {
    registerEmailTemplates(
      defs
        .filter((def) => !emailTemplateRegistry.has(def.name))
        .map((def) => ({
          name: def.name,
          registrant: 'memoriahub',
          render: ((data: never, ctx?: EmailRenderContext) => {
            const context = resolveEmailRenderContext(ctx);
            return def.render(data, emailKit(context));
          }) as never,
        })),
    );
  }

  notify(eventKey: string, userId: string, data: unknown, options?: MemoriahubNotifyOptions): void {
    this.detach(eventKey, () => this.notifications.notify(eventKey, userId, data, options));
  }

  notifyCounted(
    eventKey: string,
    userId: string,
    data: Record<string, unknown>,
    options?: MemoriahubNotifyCountedOptions,
  ): void {
    this.detach(eventKey, () => this.notifications.notifyCounted(eventKey, userId, data, options));
  }

  notifyState(
    eventKey: string,
    userId: string,
    data: { count: number } & Record<string, unknown>,
    options?: MemoriahubNotifyStateOptions,
  ): void {
    this.detach(eventKey, () => this.notifications.notifyState(eventKey, userId, data, options));
  }

  /**
   * The live STATE rows of the given events: not dismissed and carrying the platform's `state:` dedup key,
   * optionally in one scope (the `notifications` table is the platform inbox, read here with the main client).
   */
  async liveStates(eventKeys: readonly string[], scopeId?: string): Promise<MemoriahubLiveStateRow[]> {
    return this.prisma.notification.findMany({
      where: {
        eventKey: { in: [...eventKeys] },
        dismissedAt: null,
        dedupKey: { startsWith: 'state:' },
        ...(scopeId ? { scopeId } : {}),
      },
      select: { userId: true, eventKey: true, scopeId: true },
    });
  }

  async notifyNow(
    eventKey: string,
    userId: string,
    data: unknown,
    options?: MemoriahubNotifyOptions,
  ): Promise<MemoriahubNotifyNowResult> {
    try {
      return await this.notifications.notifyNow(eventKey, userId, data, options);
    } catch (error) {
      this.logger.warn(`Notification ${eventKey} failed: ${error instanceof Error ? error.message : String(error)}`);
      return { rateLimited: false, retryAfterMs: null };
    }
  }

  notifyAddress(eventKey: string, email: string, data: unknown, options?: MemoriahubNotifyOptions): void {
    this.detach(eventKey, () => this.notifications.notifyAddress(eventKey, email, data, options));
  }

  private detach(eventKey: string, send: () => Promise<void>): void {
    try {
      void send().catch((error: unknown) => {
        this.logger.warn(`Notification ${eventKey} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      this.logger.warn(`Notification ${eventKey} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The layout helpers a slice's email template is given, over the platform layout of one render. */
function emailKit(context: EmailRenderContext): MemoriahubEmailKit {
  return {
    appName: context.appName,
    headers: TRANSACTIONAL_EMAIL_HEADERS,
    escapeHtml,
    safeUrl,
    layout: (opts) =>
      renderLayout(
        {
          title: opts.title,
          ...(opts.previewText !== undefined ? { previewText: opts.previewText } : {}),
          bodyHtml: SafeHtml.unsafeFromTrustedString(opts.bodyHtml),
          ...(opts.ctaLabel !== undefined ? { ctaLabel: opts.ctaLabel } : {}),
          ...(opts.ctaUrl !== undefined ? { ctaUrl: opts.ctaUrl } : {}),
        },
        context,
      ),
    plainText: (opts) => plainText(opts, context),
    formatDate: (date, timeZone) => formatEmailDate(date, { timeZone: timeZone ?? context.timeZone ?? null }),
    formatDateTime: (date, timeZone) => formatEmailDateTime(date, { timeZone: timeZone ?? context.timeZone ?? null }),
  };
}
