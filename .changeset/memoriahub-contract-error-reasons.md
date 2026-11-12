---
"@marinoscar/memoriahub-contract": minor
"@marinoscar/memoriahub-web": patch
---

Add `UPLOAD_ERROR_REASONS` (`UPLOAD_PARTS_MISSING`, `UPLOAD_SESSION_INVALID`), `ANDROID_APP_ERROR_REASONS` (`NO_RELEASE`), `uploadPartsMissingDetailsSchema` and `errorReasonDetailsSchema` to `@marinoscar/memoriahub-contract/errors`. The CLI uploader and the Android download page import these constants instead of repeating the literals. The wire strings are unchanged and OpenAPI is byte-identical.
