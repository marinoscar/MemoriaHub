import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_SINK, type AuditEventInput, type AuditSink } from '@marinoscar/platform-api/core';
import { Trace } from '@marinoscar/platform-api/otel-core';
import type { MemoriahubAuditEvent, MemoriahubAuditPort } from '@marinoscar/memoriahub-api/ports';

// =============================================================================
// PlatformMemoriahubAuditAdapter: the `MEMORIAHUB_AUDIT` port over the platform `AUDIT_SINK`
// (RETRO-J4, #610)
// =============================================================================
//
// The sink is MemoriaHub's `PrismaAuditSink` (`platform/audit-sink.adapter.ts`), which logs and swallows a
// failed write: a lost audit row must not fail the action it records. The sink takes scalars only, so a
// non-scalar `meta` value is stringified rather than dropped.
// =============================================================================

@Injectable()
export class PlatformMemoriahubAuditAdapter implements MemoriahubAuditPort {
  constructor(@Inject(AUDIT_SINK) private readonly sink: AuditSink) {}

  @Trace()
  async record(event: MemoriahubAuditEvent): Promise<void> {
    await this.sink.record({
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      ...(event.meta !== undefined ? { meta: scalars(event.meta) } : {}),
    });
  }
}

/** The port's `meta` as the sink takes it: strings, numbers, booleans and null. */
function scalars(meta: Record<string, unknown>): NonNullable<AuditEventInput['meta']> {
  const out: NonNullable<AuditEventInput['meta']> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (value !== undefined) {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}
