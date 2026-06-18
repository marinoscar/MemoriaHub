import { Injectable, Optional, Inject, Logger } from '@nestjs/common';
import { EnrichmentHandler, ENRICHMENT_HANDLER } from './enrichment-handler.interface';

@Injectable()
export class EnrichmentHandlerRegistry {
  private readonly logger = new Logger(EnrichmentHandlerRegistry.name);
  private readonly registry = new Map<string, EnrichmentHandler>();

  constructor(
    @Optional()
    @Inject(ENRICHMENT_HANDLER)
    handlers: EnrichmentHandler | EnrichmentHandler[] | null,
  ) {
    const handlerList = handlers
      ? Array.isArray(handlers)
        ? handlers
        : [handlers]
      : [];

    for (const handler of handlerList) {
      if (this.registry.has(handler.type)) {
        this.logger.warn(`Duplicate handler registered for type "${handler.type}"; overwriting.`);
      }
      this.registry.set(handler.type, handler);
      this.logger.log(`Registered enrichment handler for type "${handler.type}"`);
    }
  }

  get(type: string): EnrichmentHandler | undefined {
    return this.registry.get(type);
  }

  types(): string[] {
    return Array.from(this.registry.keys());
  }
}
