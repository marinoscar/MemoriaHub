import { Module } from '@nestjs/common';
import {
  SearchAgentController,
  SearchController,
  SearchModule as SearchCoreModule,
} from '@marinoscar/memoriahub-api/search';

/**
 * Search (RETRO-J7, #618). Deterministic, semantic and agentic search live in
 * `@marinoscar/memoriahub-api/search`; they reach the platform only through the ports bound in
 * `platform-memoriahub/`. This module mounts the slice's controllers where the old ones sat (the
 * OpenAPI document follows module order) and re-exports the packaged slice.
 */
@Module({
  imports: [SearchCoreModule.forRoot()],
  controllers: [SearchController, SearchAgentController],
  exports: [SearchCoreModule.forRoot()],
})
export class SearchModule {}
