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
}
