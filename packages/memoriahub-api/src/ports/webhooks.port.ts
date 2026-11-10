// =============================================================================
// MEMORIAHUB_WEBHOOKS: the outbound-webhook port (RETRO-J4, #610)
// =============================================================================
//
// Lets a slice publish a small, content-free fact ("a workflow run finished") to
// the webhooks a user or an organization configured. The web edition binds it over
// the platform webhooks slice; a bare host binds nothing, and an unbound port is a
// no-op (`NOOP_MEMORIAHUB_WEBHOOKS` of `@marinoscar/memoriahub-api/core`).
//
// WHAT CROSSES THIS PORT: identifiers and counts, never media content, a file name
// or a face. A BINDING DOES NO NETWORK I/O INLINE: `emit` may write the delivery
// rows and enqueue the delivery job, nothing slower. Emit AFTER the triggering
// write commits, outside any transaction.
// =============================================================================

/**
 * Injection token of {@link MemoriahubWebhooksPort}. The description string is
 * permanent. Optional in `MemoriahubPortsModule.forRoot`: the default does nothing.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_WEBHOOKS = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_WEBHOOKS');

/**
 * Who a webhook event belongs to.
 *
 * @stability experimental
 */
export interface MemoriahubWebhookContext {
  /** The organization the event belongs to, or `null` when the host resolves the default. */
  orgId: string | null;
  /** The user the event is about, when it has one. */
  userId?: string;
}

/**
 * The webhook port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubWebhooksPort {
  /**
   * Publishes an event to the matching webhooks.
   *
   * @param eventKey - a registered webhook event key.
   * @param data - the event data: ids and counts only.
   * @param ctx - whose event it is.
   */
  emit(eventKey: string, data: unknown, ctx: MemoriahubWebhookContext): Promise<void>;
}
