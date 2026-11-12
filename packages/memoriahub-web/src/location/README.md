# location

Location settings on the web: the admin Geo page, the admin Location Groups page, the group editor and the merge dialog, with the clients behind them.

## Purpose and scope

`location/headless` carries the geo provider clients (`getGeoSettings`, `putGeoCredentials`, `deleteGeoCredentials`, `testGeoProvider`, `putGeoReverseFeature`, `runGeoBackfill`) and the `useGeoSettings` hook, and the Location Grouping clients (`listLocationGroups`, `createLocationGroup`, `mergeLocationGroups`, `rebuildLocationGroups`, the raw-values and suggestions lists, `extractLocationGroupConflict`) with their wire types. `location/ui` carries `GeoSettingsPage` (the reverse provider, the Google key, forward search, the geocode backfill), `LocationGroupsSettingsPage` (the Location Grouping switch and tuning, suggestions, the group lists per tier, the all-locations merge list, the rebuild), `LocationGroupEditorDialog` and `MergeLocationsDialog`.

The pages take their page header, write-only secret input and settings hook from the host's admin port (`useMemoriahubAdmin` of `core`) and stay registered in the app's admin section registry. `MergeLocationsDialog` is also what the host binds to the media slice's `media.mergeLocationsDialog` slot: `location` imports `media`, so `media` reaches the dialog through the slot.

## Entry point

`@marinoscar/memoriahub-web/location/headless` and `@marinoscar/memoriahub-web/location/ui`. The slice imports `core` and `media` through their entries.

## Peer dependencies

`react`, `react-dom` and `@marinoscar/memoriahub-contract` for every file (the Location Grouping wire schemas); the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, permissions, owner scope and admin port.

## Extension-point catalog

None: the slice registers no slot of its own.
