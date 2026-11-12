# media

The photo and video library UI: gallery, bulk toolbars and dialogs, albums, the map, places, archive and trash, with the clients and hooks behind them.

## Purpose and scope

`media/headless` carries the media clients over the host's API client (`services`: list, albums, bulk actions, upload, geo, explore, metadata and thumbnail re-run, the empty-trash run), the hooks that load them (`useInfiniteMedia`, `useAlbums`, `useMedia`, ...), the shared preview and refresh contexts and the **civil date utilities** (`civilDate`, `dateRangeBounds`, `groupByDay`): `captured_at` is the photographer's wall clock re-encoded as UTC, so a photo's date is rendered in UTC and never in the viewer's zone ([The Date Model](../../../../docs/specs/date-model.md)). `media/ui` carries `MediaGallery`, the bulk toolbars and dialogs, the location pickers and mini map, the album dialogs, the map components and the pages (`MediaLibraryPage`, `AlbumsPage`, `AlbumPage`, `ArchivePage`, `TrashPage`, `PlacesOverviewPage`, `LevelBrowsePage`, `MediaMapPage`) and the admin `ArchivingSettingsPage` (the trash retention period; it takes its header and settings hook from the host's admin port). Components the pages cannot import are reached through host slots (`slots`): the share dialog (the platform's), and the lightbox, the detail drawer, the album people dialog, the location-merge dialog, the person multi-select, the AI enhancement drawer and the batch enhance dialog, which stay slots for good because the `viewer`, `people`, `location` and `enhancement` slices import this one (the host binds them to those slices' components). Staying in the app until their slices move: the lightbox and detail drawer (face, tagging, location-suggestion and enhancement hooks), the circles, sharing and owner-scope UI. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-web/media/headless` and `@marinoscar/memoriahub-web/media/ui`. The slice imports `core` through its entries.

## Peer dependencies

`react`, `react-dom`, `hash-wasm` and the optional `@marinoscar/memoriahub-contract` (type-only) for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material`, `react-router-dom`, `leaflet`, `leaflet.markercluster` and `react-leaflet`.

## Configuration

The host registers the slot components under the names exported from `media/headless` (`MEDIA_LIGHTBOX_SLOT`, `MEDIA_DETAIL_DRAWER_SLOT`, `MEDIA_ENHANCEMENT_DRAWER_SLOT`, `BATCH_ENHANCE_DIALOG_SLOT`, `MEDIA_SHARE_DIALOG_SLOT`, `ALBUM_PEOPLE_DIALOG_SLOT`, `PERSON_MULTI_SELECT_SLOT`, `MERGE_LOCATIONS_DIALOG_SLOT`); the prop types are exported from `media/ui` (`MediaLightboxSlotProps`, ...). The host's `search` port receives the map's "Show all photos here" filter, and its `shell` port gives the map the full-bleed layout.

## Extension-point catalog

The slot bridges (`MediaLightboxSlot`, `MediaDetailDrawerSlot`, `MediaEnhancementDrawerSlot`, `BatchEnhanceDialogSlot`, `MediaShareDialogSlot`, `AlbumPeopleDialogSlot`, `PersonMultiSelectSlot`, `MergeLocationsDialogSlot`) are the extension points: the host chooses the component. Each is deleted when the slice that owns the component moves into the package, except `AlbumPeopleDialogSlot`, `PersonMultiSelectSlot`, `MediaEnhancementDrawerSlot` and `BatchEnhanceDialogSlot`: the people and enhancement slices import `media`, so `media` cannot import them back.
