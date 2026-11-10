# brand

The product identity and the mark every host paints, from `packages/shared/identity.json`.

## Purpose and scope

`MEMORIAHUB_BRAND` carries the product name, tagline and the two colours of the identity manifest; `BrandMark` is the SVG mark; the asset exports are the favicon set, the PWA icons, the SVG mark and the app logo. The values are generated into `identity.ts` by `scripts/sync-brand-identity.mjs` (a package cannot import the private `@app/shared`), and a test fails when the file is stale. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-web/brand`, and the asset exports `@marinoscar/memoriahub-web/brand/assets/mark.svg`, `@marinoscar/memoriahub-web/brand/assets/favicon.ico`, `@marinoscar/memoriahub-web/brand/assets/favicon-16x16.png`, `@marinoscar/memoriahub-web/brand/assets/favicon-32x32.png`, `@marinoscar/memoriahub-web/brand/assets/apple-touch-icon.png`, `@marinoscar/memoriahub-web/brand/assets/android-chrome-192x192.png`, `@marinoscar/memoriahub-web/brand/assets/android-chrome-512x512.png`, `@marinoscar/memoriahub-web/brand/assets/icon-192.png`, `@marinoscar/memoriahub-web/brand/assets/icon-512.png`, `@marinoscar/memoriahub-web/brand/assets/icon-maskable-192.png`, `@marinoscar/memoriahub-web/brand/assets/icon-maskable-512.png`, `@marinoscar/memoriahub-web/brand/assets/badge-72.png`, `@marinoscar/memoriahub-web/brand/assets/app-logo.png`.

## Peer dependencies

`react`.

## Configuration

After a rebrand (`scripts/rename.mjs`), run `npm run brand:sync -w @marinoscar/memoriahub-web`. The PWA icons are also served by the app's own `public/` folder (the service worker and the manifest name them); a test asserts the two copies are byte-equal.

## Extension-point catalog

None. The brand is data and one component; a host paints it, it does not extend it.
