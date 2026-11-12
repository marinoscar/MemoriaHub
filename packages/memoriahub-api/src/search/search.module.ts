import { Module, type DynamicModule } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { SearchAgentService } from './agent/search-agent.service.js';
import { SearchService } from './search.service.js';
import { SemanticSearchService } from './semantic-search.service.js';
import { AiEmbeddingDoctorCheck } from './doctor/ai-embedding.doctor-check.js';
import { AiSearchDoctorCheck } from './doctor/ai-search.doctor-check.js';

/**
 * Options of {@link SearchModule.forRoot}. None yet: the agent's round budget is a constant of the
 * slice and the models are the `ai.features.search` and `ai.features.embedding` selections, read
 * through the settings port.
 *
 * @stability experimental
 */
export interface SearchModuleOptions {
  /** Reserved for the options the slice may take (the agent's round budget). */
  readonly reserved?: never;
}

/**
 * The search slice (RETRO-J7, #618): deterministic search over the searchable-field registry,
 * semantic search (pgvector KNN over `media_item_embedding`, falling back to the filters when no
 * embedding model is configured) and the stateless agentic search. It reaches the outside only through
 * the ports of `@marinoscar/memoriahub-api/ports`; AI goes through `MEMORIAHUB_AI`, and results come
 * only after `MEMORIAHUB_ACCESS.requireOwnerRole` on the scope.
 *
 * The slice's controllers (`SearchController`, `SearchAgentController`) are exported classes, not
 * mounted by `forRoot()`: the host lists them in the `controllers` of the module where its routes
 * belong, so the order of its OpenAPI document stays the host's decision.
 *
 * @stability experimental
 */
@Module({})
export class SearchModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module. The result is cached, so every `forRoot()` call names the same instance.
   *
   * @param _options - reserved.
   */
  static forRoot(_options: SearchModuleOptions = {}): DynamicModule {
    SearchModule.root ??= {
      module: SearchModule,
      imports: [MediaModule.forRoot()],
      providers: [SearchService, SemanticSearchService, SearchAgentService, AiSearchDoctorCheck, AiEmbeddingDoctorCheck],
      exports: [SearchService, SemanticSearchService, SearchAgentService],
    };
    return SearchModule.root;
  }
}
