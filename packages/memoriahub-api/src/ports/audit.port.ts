// =============================================================================
// MEMORIAHUB_AUDIT: the audit port (RETRO-J4, #610)
// =============================================================================
//
// Audit rows for destructive and settings-changing actions (a burst group
// resolved, a memory deleted, an enhancement applied). Optional: a host that binds
// nothing gets a no-op. Record AFTER the triggering write has committed; `meta`
// carries scalars only and never a secret.
// =============================================================================

/**
 * Injection token of {@link MemoriahubAuditPort}. The description string is
 * permanent. Optional in `MemoriahubPortsModule.forRoot`: the default does nothing.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_AUDIT = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_AUDIT');

/**
 * One audit row.
 *
 * @stability experimental
 */
export interface MemoriahubAuditEvent {
  /** Who did it, or `null` for the system. */
  actorUserId: string | null;
  /** What happened (`burst_group:resolved`). */
  action: string;
  /** The kind of thing it happened to. */
  targetType: string;
  /** Which one. */
  targetId: string;
  /** Scalar details. Never a secret. */
  meta?: Record<string, unknown>;
}

/**
 * The audit port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubAuditPort {
  /**
   * Records an event. Never rejects: a lost audit row must not fail the action.
   *
   * @param event - the event.
   */
  record(event: MemoriahubAuditEvent): Promise<void>;
}
