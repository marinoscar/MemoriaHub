---
"@marinoscar/memoriahub-web": minor
---

Add the `search` slice to `@marinoscar/memoriahub-web` (private): the search clients and the agent SSE stream (`search/headless`) and `SearchProvider`/`useSearch`, `SearchPanel`, `TopbarSearch`, `PageSearchBar` and `SearchPage` (`search/ui`). `MemoriahubApiClient` gains `rewriteBody`, the owner-scope rewrite of a JSON body for requests that bypass the client (the agent stream). The explore view's people carousel is a host slot (`search.peopleExplore`) until the people slice moves. The web app mounts the packaged page, provider and pill unchanged for users.
