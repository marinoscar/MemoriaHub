# social

Social-media video detection settings on the web: the admin Social Media page and the two clients behind it.

## Purpose and scope

`social/headless` carries the admin clients `getSocialMediaStatus` (the OCR fallback's availability) and `backfillSocialMedia` (the global backfill) with their wire types. `social/ui` carries `SocialMediaSettingsPage`: the global detection switch (`features.socialMediaDetection`), the OCR and cap parameters (`socialMedia.*`), the OCR model status and the backfill.

The page takes its page header and settings hook from the host's admin port (`useMemoriahubAdmin` of `core`) and stays registered in the app's admin section registry.

## Entry point

`@marinoscar/memoriahub-web/social/headless` and `@marinoscar/memoriahub-web/social/ui`. The slice imports `core` through its entries.

## Peer dependencies

`react` and `react-dom` for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, permissions and admin port.

## Extension-point catalog

None: the slice registers no slot of its own.
