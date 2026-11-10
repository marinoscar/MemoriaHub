import { Logger } from '@nestjs/common';

import type { MemoriahubEventsPort } from '../../ports/index.js';

/**
 * An in-process event emitter: the default `MEMORIAHUB_EVENTS` binding of a host that binds none. A
 * listener runs on a later microtask; one that throws or rejects is logged, never propagated.
 *
 * @stability experimental
 */
export class InProcessMemoriahubEvents implements MemoriahubEventsPort {
  private readonly logger = new Logger(InProcessMemoriahubEvents.name);

  private readonly listeners = new Map<string, Set<(payload: unknown) => Promise<void> | void>>();

  /**
   * Publishes an event to this process's listeners. Never throws and never waits.
   *
   * @param name - the event name.
   * @param payload - plain data.
   */
  emit(name: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      void Promise.resolve()
        .then(() => listener(payload))
        .catch((error: unknown) => {
          this.logger.warn(`A listener of ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
  }

  /**
   * Listens for an event.
   *
   * @param name - the event name.
   * @param handler - called for each event.
   * @returns a function that removes the listener.
   */
  subscribe(name: string, handler: (payload: unknown) => Promise<void> | void): () => void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(handler);
    this.listeners.set(name, set);

    return () => {
      set.delete(handler);
    };
  }
}
