// =============================================================================
// MEMORIAHUB_EVENTS: the domain-event port (RETRO-J4, #610)
// =============================================================================
//
// In-process domain events emitted after a write commits (a media item was
// processed, a review group was resolved). Listeners are bystanders: they decide
// whether work is due and enqueue it, they never compute or do I/O inline (the
// `on-event-no-io` conformance rule). Names are lower-case and dotted; a payload is
// plain data.
// =============================================================================

/**
 * Injection token of {@link MemoriahubEventsPort}. The description string is
 * permanent. Optional in `MemoriahubPortsModule.forRoot`: the default is an
 * in-process emitter.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_EVENTS = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_EVENTS');

/**
 * The event port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubEventsPort {
  /**
   * Publishes an event. Never throws and never waits for listeners.
   *
   * @param name - the event name.
   * @param payload - plain data.
   */
  emit(name: string, payload: unknown): void;

  /**
   * Listens for an event. A listener that throws is logged, never propagated.
   *
   * @param name - the event name.
   * @param handler - called for each event.
   * @returns a function that removes the listener.
   */
  subscribe(name: string, handler: (payload: unknown) => Promise<void> | void): () => void;
}
