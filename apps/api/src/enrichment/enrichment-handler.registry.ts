import { Injectable, Logger } from '@nestjs/common';
import { EnrichmentHandler } from './enrichment-handler.interface';

@Injectable()
export class EnrichmentHandlerRegistry {
  private readonly logger = new Logger(EnrichmentHandlerRegistry.name);
  private readonly handlers = new Map<string, EnrichmentHandler>();

  register(handler: EnrichmentHandler): void {
    if (this.handlers.has(handler.type)) {
      this.logger.warn(`Duplicate handler registered for type "${handler.type}"; overwriting.`);
    }
    this.handlers.set(handler.type, handler);
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
   * worker — a distributed worker node has no way to submit a result for them.
   * Used to build the `ENRICHMENT_WORKER_MODE=system` claim set (see
   * `systemModeEligibleTypes` in enrichment-job.worker.ts, which also adds
   * `thumbnail_repair` explicitly).
   */
  serverOnlyTypes(): string[] {
    return Array.from(this.handlers.values())
      .filter((h) => !(h.nodeResultSchema && typeof h.persistNodeResult === 'function'))
      .map((h) => h.type);
  }
}
