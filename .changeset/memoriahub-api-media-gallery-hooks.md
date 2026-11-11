---
"@marinoscar/memoriahub-api": minor
---

Break the `media` <-> `location` cycle ahead of moving the gallery service: `fold`, `GEO_CLEAR_COLUMNS`, `geoResultToMediaColumns` and `applyLocation` now live in the `media` slice (`location` re-exports them, so its public names are unchanged), and `media` gains four host hooks the gallery service needs: `MEDIA_GEO_LOCATION_PROVIDER`, `MEDIA_FORWARD_GEOCODER`, `MEDIA_ENRICHMENT` and `MEDIA_WEBHOOK_EVENTS`.
