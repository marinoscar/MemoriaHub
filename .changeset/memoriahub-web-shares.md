---
"@marinoscar/memoriahub-web": minor
---

Add the `shares` slice to `@marinoscar/memoriahub-web` (private): the public-link wire types, clients (`listShares`, `updateShare`, `revokeShare`, `bulkShares`), `useMediaShares` and `PublicSharesPage`. The admin port's data table contract is widened with the filter model (`filters`, `onFiltersChange`, `filterable`, `filterType`, `enumValues`), row selection (`selection`), bulk actions (`bulkActions`), `exportable` and `error`, all structural subsets of what the platform table already accepts. The web app keeps the page in its admin section registry.
