import { Injectable, Logger } from '@nestjs/common';
import type { AuditEventInput, AuditSink } from '@marinoscar/platform-api/core';

import { PrismaService } from '../prisma/prisma.service';

/**
 * The platform's `AUDIT_SINK` over MemoriaHub's `audit_events` table.
 *
 * Packaged slices report audit events here after the triggering write has
 * committed (maintenance mode today; the identity, settings and storage slices
 * as they are adopted). `meta` carries scalars only (the port's contract), so
 * it is stored as given.
 *
 * A failed audit write is logged and swallowed: the audit trail is evidence
 * about an action that already happened, and losing a row must not fail the
 * request (the old maintenance service had the same posture).
 */
@Injectable()
export class PrismaAuditSink implements AuditSink {
  private readonly logger = new Logger(PrismaAuditSink.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEventInput): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: event.actorUserId,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          ...(event.meta ? { meta: event.meta } : {}),
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write audit event ${event.action}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
