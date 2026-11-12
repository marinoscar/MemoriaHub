# search

Search over the library: the deterministic filter panel, the AI (agentic) search, the top-bar search pill, the page search bar and the Search page with its explore view, and the clients behind them.

## Purpose and scope

`search/headless` carries the clients over the host's API client (`getSearchFields`, `performSearch`, and `streamAgent`, the stateless SSE client of `POST /api/search/agent`, which sends the whole message history on every call and applies the host's owner-scope rewrite to its body), the request and response types and a `useDeterministicSearch` hook. `search/ui` carries `SearchProvider` and `useSearch` (the one search state the top bar and the page share: the agent chat, its results and the deterministic request), `SearchPanel` (the advanced-filter dialog body), `TopbarSearch`, `PageSearchBar`, `PageSearchBarSection` and `SearchPage`. The provider also feeds the host's `search` port: the app re-provides the host with `runDeterministicSearch` filled in, so a slice that has a filter to show (the map) hands it over without importing the search state. The people picker of the panel (`PersonMultiSelect`) and the people carousel of the explore view (`SearchPeopleExplore`) are the `people` slice's components, imported directly.

Staying in the app: the search-fields settings card.

## Entry point

`@marinoscar/memoriahub-web/search/headless` and `@marinoscar/memoriahub-web/search/ui`. The slice imports `core`, `media` and `people` through their entries.

## Peer dependencies

`react`, `react-dom` and the optional `@marinoscar/memoriahub-contract` (type-only) for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

`SearchProvider` must sit under the host provider and inside the router, once, above the top bar and the Search page. The host's API client supplies the credential, the API root (`baseUrl`) and `rewriteBody` for the streamed request.

## Extension-point catalog

None: the slice registers no slot of its own. (`SEARCH_PEOPLE_EXPLORE_SLOT` and `SearchPeopleExploreSlot` were removed when the people slice moved into the package.)
