import type {
  MemoriahubAuditEvent,
  MemoriahubAuditPort,
  MemoriahubMetricsPort,
  MemoriahubWebhookContext,
  MemoriahubWebhooksPort,
} from '../ports/index.js';

/**
 * A `MEMORIAHUB_AUDIT` that keeps every event.
 *
 * @stability experimental
 */
export class RecordingMemoriahubAudit implements MemoriahubAuditPort {
  /** The events, in order. */
  readonly events: MemoriahubAuditEvent[] = [];

  /** Records an event. */
  async record(event: MemoriahubAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

/**
 * A `MEMORIAHUB_WEBHOOKS` that keeps every emit.
 *
 * @stability experimental
 */
export class RecordingMemoriahubWebhooks implements MemoriahubWebhooksPort {
  /** The emits, in order. */
  readonly emitted: Array<{ eventKey: string; data: unknown; ctx: MemoriahubWebhookContext }> = [];

  /** Records an emit. */
  async emit(eventKey: string, data: unknown, ctx: MemoriahubWebhookContext): Promise<void> {
    this.emitted.push({ eventKey, data, ctx });
  }
}

/**
 * A `MEMORIAHUB_METRICS` that keeps every observation.
 *
 * @stability experimental
 */
export class RecordingMemoriahubMetrics implements MemoriahubMetricsPort {
  /** The observations, in order. */
  readonly observations: Array<{ kind: 'add' | 'record'; key: string; value: number; attributes?: Record<string, unknown> }> = [];

  /** Adds to a counter. */
  add(key: string, value = 1, attributes?: Record<string, unknown>): void {
    this.observations.push({ kind: 'add', key, value, ...(attributes ? { attributes } : {}) });
  }

  /** Records a histogram value. */
  record(key: string, value: number, attributes?: Record<string, unknown>): void {
    this.observations.push({ kind: 'record', key, value, ...(attributes ? { attributes } : {}) });
  }
}
