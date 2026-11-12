# shares

The admin Public Sharing page on the web: every public link of the organization, with the clients behind it.

## Purpose and scope

`shares/headless` carries the link wire types (`MediaShare`, `ShareStatus`, `ShareTargetType`), the clients over the MemoriaHub list route (`GET /api/admin/links`, listed through `listShares`) and the sharing slice's grant routes (`updateShare`, `revokeShare`, `bulkShares`: one call per selected link) and the `useMediaShares` hook. `shares/ui` carries `PublicSharesPage` and `sharesTable` (the column declarations and the pure mapping between the table's filter model and the list query).

The page draws its table through the host's admin port: columns with filter, enum and export declarations, a controlled filter model, row selection, per-row and bulk actions, pagination and CSV export. The All / Active / Expired / Revoked tabs write into that same filter model, and the `status` column declares no `filterable` so no second control competes for the param. The public URL column is `exportable: false`: a link's token is a bearer credential and never reaches a CSV.

The page stays registered in the app's admin section registry.

## Entry point

`@marinoscar/memoriahub-web/shares/headless` and `@marinoscar/memoriahub-web/shares/ui`. The slice imports `core` through its entries.

## Peer dependencies

`react` and `react-dom` for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, permissions and admin port.

## Extension-point catalog

None: the slice registers no slot of its own.
