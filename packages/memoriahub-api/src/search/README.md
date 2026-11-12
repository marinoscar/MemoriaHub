# search

Deterministic, semantic and agentic media search of the MemoriaHub domain, written against the host ports (RETRO-J7, #618). It imports no provider SDK, no `@marinoscar/platform-*` package and no generated database client.

## Purpose and scope

Owns: `SearchService` (`POST /api/search`: the searchable-field registry, AND-composed filter fragments, optional `semanticQuery` ranking, signed thumbnails through the media slice), the `SEARCHABLE_FIELDS` registry and `buildWhereFromFields` (the one source of truth for the filter dimensions the route and the agent's tool both read; an unknown key is a 400), `SemanticSearchService` (embeds the query as the caller under the `semantic_embedding` feature and runs the pgvector KNN over `media_item_embedding`; with no embedding model configured the search falls back to the filters), `SearchAgentService` and `SearchAgentController` (`POST /api/search/agent`, a stateless chat over Server-Sent Events whose one tool, `search_media`, runs the same search; events `tool_call`, `token`, `results`, `done`, `error`), and `SearchController`. Does not own: the `where*` builders (the media slice), the provider adapters and keys (the host), the search UI. Status: experimental until the first published release.

A search never trusts an id from the client alone: `MEMORIAHUB_ACCESS.requireOwnerRole` answers not-found to a non-member, every query is bound to that scope and to live (not trashed) rows, and the agent takes the scope from the request, never from what the model asks for.

## Entry point

`@marinoscar/memoriahub-api/search` (and `./search/testing` for the conformance kit and the in-memory store). It imports the `ports`, `core`, `media` and `tagging` slices through their `index.ts` (the tagging slice owns the embedding dimension guard and the feature ids).

## Peer dependencies

`@nestjs/common`, `@nestjs/swagger`, `nestjs-zod`, `zod`, `@marinoscar/memoriahub-contract` (the query and agent-turn schemas) and, through the tagging slice, `@marinoscar/memoriahub-compute`, `csv-parse` and `csv-stringify`.

## Configuration

`SearchModule.forRoot(options)`; the options object is reserved and empty today. The models are the `ai.features.search` and `ai.features.embedding` selections, read through the settings port; the host registers the `search_agent` AI feature and mounts `SearchController` and `SearchAgentController` in its own module. The SSE route owns its response (`@Res()`): the host's response interceptor skips `/api/search/agent`, and a proxy must not buffer it (`X-Accel-Buffering: no`).

## Extension-point catalog

`SEARCHABLE_FIELDS` is the extension point: one `SearchableField` entry (`key`, `label`, `type`, `description`, `buildWhere`) adds a filter dimension to the route, the field listing and the agent's tool at once. Add to the array; never rename or remove a key a client sends.

**Diagnostics (RETRO-J10, #624).** The slice registers `memoriahub.ai.search` (`AiSearchDoctorCheck`, a live `testModel` probe of `ai.features.search`) and `memoriahub.ai.embedding` (`AiEmbeddingDoctorCheck`, a live `testEmbedding` probe that warns when the vectors do not fit the 1536-d storage), both through the optional `MEMORIAHUB_AI_ADMIN` port; a host that binds none skips them. Ids, statuses and remedies are unchanged.
