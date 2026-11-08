import { Injectable, Logger, Optional } from '@nestjs/common';

import { LegacyEnrichmentHandlerAdapter } from '../platform/jobs/legacy-handlers.adapter';
import { EnrichmentHandler } from './enrichment-handler.interface';

/**
 * The 38 legacy handlers register here from their modules' `onModuleInit`
 * (RETRO-C1, #575). Every registration is forwarded to the platform queue
 * through `LegacyEnrichmentHandlerAdapter`, which wraps the handler in a
 * `JobHandler` with the same `type` and registers it with `JobHandlerRegistry`.
 * Registering at `onModuleInit`, before the platform worker starts at
 * `onApplicationBootstrap`, is the same guarantee the old worker relied on.
 *
 * The local map stays so the legacy node plane (`NodesService`) and the specs
 * can still look a handler up by type. Constructed with no adapter (the handler
 * specs do `new EnrichmentHandlerRegistry()`), it only records.
 *
 * PLATFORM-ADOPTION-SHIM(RETRO-C3..C8): each conversion to a native `JobHandler`
 * registers with `JobHandlerRegistry` directly; C11 deletes this class.
 */
@Injectable()
export class EnrichmentHandlerRegistry {
  private readonly logger = new Logger(EnrichmentHandlerRegistry.name);
  private readonly handlers = new Map<string, EnrichmentHandler>();

  constructor(@Optional() private readonly adapter?: LegacyEnrichmentHandlerAdapter) {}

  register(handler: EnrichmentHandler): void {
    if (this.handlers.has(handler.type)) {
      this.logger.warn(`Duplicate handler registered for type "${handler.type}"; overwriting.`);
    }
    this.handlers.set(handler.type, handler);
    this.adapter?.register(handler);
    this.logger.log(`Registered enrichment handler for type "${handler.type}"`);
  }

  get(type: string): EnrichmentHandler | undefined {
    return this.handlers.get(type);
  }

  types(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Types whose handler lacks the node-result pair (`nodeResultSchema` +
   * `persistNodeResult`) and therefore can ONLY run on the server's in-process
   * worker. The platform `JobHandlerRegistry.serverOnlyTypes()` derives the same
   * set from the adapted handlers; this one answers for the legacy ones.
   */
  serverOnlyTypes(): string[] {
    return Array.from(this.handlers.values())
      .filter((h) => !(h.nodeResultSchema && typeof h.persistNodeResult === 'function'))
      .map((h) => h.type);
  }
}
