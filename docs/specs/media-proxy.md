# Media Byte Proxy — Same-Origin Delivery & Zscaler Fix

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Root Cause: Zscaler, `_sm_nck`, and SigV4](#2-root-cause-zscaler-sm_nck-and-sigv4)
3. [Why Not Just Send a Bearer Token](#3-why-not-just-send-a-bearer-token)
4. [Design: Same-Origin HMAC Proxy](#4-design-same-origin-hmac-proxy)
5. [Token Generation and Signing](#5-token-generation-and-signing)
6. [Validation and Status Codes](#6-validation-and-status-codes)
7. [Streaming and Range Requests](#7-streaming-and-range-requests)
8. [What Is — and Isn't — Proxied](#8-what-is--and-isnt--proxied)
9. [Bytes-Through-VPS Trade-off](#9-bytes-through-vps-trade-off)
10. [Future Option: Cloudflare Worker](#10-future-option-cloudflare-worker)
11. [Revert Switch](#11-revert-switch)
12. [EXIF / GPS Limitation](#12-exif--gps-limitation)
13. [Configuration Reference](#13-configuration-reference)
14. [API Reference](#14-api-reference)
15. [Key Files](#15-key-files)

---

## 1. Overview and Goals

MemoriaHub serves browser-facing media (thumbnails, full-resolution images, video) via time-limited signed URLs pointing at the configured object-storage provider (AWS S3 or Cloudflare R2). Users on networks with a TLS-inspecting corporate proxy (Zscaler in the field report that triggered this fix) received **403 Forbidden** errors loading every thumbnail and download, even though the same user could load the same URLs from an unmanaged network.

This document describes the fix: a same-origin, authenticated-by-token byte-proxy endpoint (`GET /api/media/blob`) that serves media bytes through the MemoriaHub API/VPS instead of directly from the storage provider's domain.

### Goals

- Eliminate 403s caused by corporate proxies rewriting or appending query parameters to storage-provider URLs.
- Keep the browser talking only to MemoriaHub's own origin for media bytes — no third-party storage hostname in `<img>`/`<video>` `src` attributes.
- Preserve Range-request support for video seeking.
- Provide an instant, no-code-change revert path if the proxy causes unexpected load or regressions.

### Non-Goals

- This is not a general-purpose storage abstraction change — server-to-server and CLI paths are untouched (see [§8](#8-what-is--and-isnt--proxied)).
- File-level EXIF/GPS stripping is out of scope (see [§12](#12-exif--gps-limitation)), matching the same known limitation already documented for public shares.

---

## 2. Root Cause: Zscaler, `_sm_nck`, and SigV4

Browser-facing thumbnail and download URLs are AWS SigV4 presigned URLs of the form:

```
https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=...
  &X-Amz-Date=...
  &X-Amz-Expires=3600
  &X-Amz-SignedHeaders=host
  &X-Amz-Signature=<hex>
```

SigV4 signatures are computed over a **canonical request** that includes the exact query string present at signing time. The signature is a hash of (among other things) every query parameter name and value, in a defined sort order.

Zscaler — like several other corporate TLS-inspection/DLP proxies — transparently injects its own tracking query parameter (`_sm_nck=1`) into outbound HTTPS requests as they pass through the proxy, *after* the browser has already constructed and sent the request with the correct signed query string. By the time the request reaches Cloudflare R2, the query string no longer matches what was signed: R2 recomputes the canonical request including `_sm_nck`, gets a different signature than the one supplied, and rejects the request with `403 Forbidden` — a generic SigV4 signature-mismatch error that looks identical to an expired or malformed presigned URL, giving no direct clue that a corporate proxy is the cause.

This is a structural incompatibility, not a bug in our signing code: **any** presigned-URL scheme where the signature covers the query string is vulnerable to a middlebox that appends parameters after the client signs the request. Nothing in our control over R2/S3 configuration prevents Zscaler from doing this — the fix has to move the trust boundary away from a scheme where injected query params invalidate the request.

---

## 3. Why Not Just Send a Bearer Token

The obvious alternative — require the normal JWT Bearer `Authorization` header on media requests — does not work for the two DOM elements that actually load this content:

- `<img src="...">` and `<video><source src="..."></video>` are fetched by the browser's own resource-loading machinery, which does not attach custom headers. There is no way to set `Authorization: Bearer <token>` on an `<img>` tag.
- MemoriaHub's access token is deliberately **held in memory only** (not in a cookie) as an XSS-hardening measure — it is never persisted to `localStorage`, `sessionStorage`, or a JS-readable cookie, and is not sent automatically by the browser on plain resource requests the way an `HttpOnly` cookie would be. This is consistent with the refresh-token-in-cookie / access-token-in-memory split described in `SECURITY.md`.

Some apps solve the "media needs a token but `<img>` can't send one" problem by writing the access token into a non-HttpOnly cookie so it rides along automatically. MemoriaHub deliberately avoids that trade-off — it would reintroduce exactly the XSS exposure the in-memory-token design is meant to prevent. The chosen alternative is a **self-contained, single-purpose authorization token embedded in the URL itself**: a short-lived HMAC signature over the requested storage key and expiry, generated server-side when the API builds `thumbnailUrl`/`downloadUrl`/`previewUrl`, and verified statelessly on each request with no database lookup and no session. This is the same pattern already used for public share tokens, just scoped to a single object and signed rather than random.

---

## 4. Design: Same-Origin HMAC Proxy

```
GET /api/media/blob?k=<urlencoded storageKey>&exp=<unixSeconds>&sig=<hex hmac-sha256>
```

- Decorated `@Public()` — no JWT is required or checked. The HMAC signature over `k` and `exp` **is** the authorization; anyone who obtained a valid `k`+`exp`+`sig` triple already had server-granted read access to that object at signing time (the same trust model as the public-share token, just narrower in scope and shorter-lived).
- Declared on the literal static path segment `media/blob`, registered so it is matched before the parameterized `media/:id` route — otherwise Nest/Fastify routing would treat `blob` as a media item ID and 404 or mis-route.
- Reads **only** three query parameters: `k`, `exp`, `sig`. Any additional query parameters present on the incoming request (including an injected `_sm_nck`) are ignored entirely — they play no part in signature verification, so a proxy appending extra params cannot invalidate the request. This is the core of the fix: unlike SigV4, our signature does not cover "the whole query string," it covers exactly the two values we chose to sign.

---

## 5. Token Generation and Signing

The signature is computed as:

```
sig = HMAC-SHA256(secret, `${storageKey}\n${exp}`)
```

- `secret` is `MEDIA_URL_SIGNING_SECRET`, falling back to `JWT_SECRET` if unset (see [§13](#13-configuration-reference)).
- `storageKey` is the internal object storage key (never exposed to the client except embedded, URL-encoded, in `k`).
- `exp` is a Unix timestamp (seconds) marking when the token stops being accepted.
- The resulting HMAC digest is hex-encoded into `sig`.

Tokens are generated server-side whenever the API builds a browser-facing media URL: grid/search thumbnails, burst/duplicate group covers, face thumbnails, person cover faces, the full-resolution `downloadUrl` returned by `GET /api/media/:id`, and duplicate-group `previewUrl`. Each call mints a fresh token with `exp = now + MEDIA_PROXY_URL_TTL_SECONDS`, so a URL emitted in a list response is valid for one TTL window from the moment it was generated, not from first use.

---

## 6. Validation and Status Codes

On each request to `GET /api/media/blob`:

1. Recompute `HMAC-SHA256(secret, "${k}\n${exp}")` and compare to `sig` using a **timing-safe** comparison (constant-time, to avoid a signature-guessing side channel via response-time measurement).
2. Reject if `exp < now` (token expired) — even if the signature is otherwise valid.
3. Resolve the storage object behind `k` via the same `StorageProviderResolver` used elsewhere; if the provider/object cannot be resolved (deleted, wrong provider config, etc.), the object lookup fails.

| Condition | Response |
|-----------|----------|
| Signature invalid, missing, or malformed | `403 Forbidden` |
| `exp` present but in the past | `403 Forbidden` |
| Signature valid but object/provider unresolvable | `404 Not Found` |
| Signature valid, object resolvable | `200 OK` (or `206` for a satisfied Range request) — bytes streamed |

A `403` and a `404` are deliberately distinguished here (unlike the enumeration-resistant collapsing used for public shares in `public-sharing.md` §9) because this endpoint is not a globally-guessable-token surface exposed to strangers — it backs authenticated-app UI rendering, so there is no enumeration concern to defend against, and distinguishing "bad token" from "object gone" is more useful for debugging.

---

## 7. Streaming and Range Requests

On success, the handler streams the raw bytes from the resolved storage provider directly to the HTTP response (no intermediate buffering to disk), setting:

- `Content-Type` — the object's stored MIME type.
- `Content-Disposition: inline` — renders in-browser rather than triggering a download prompt.
- `X-Content-Type-Options: nosniff` — prevents MIME-sniffing.
- `Referrer-Policy: no-referrer` — the signed URL (containing `k`/`exp`/`sig`) is never leaked via `Referer` to any third-party resource the page subsequently loads.
- `Cache-Control: private, max-age=<MEDIA_PROXY_URL_TTL_SECONDS>` — allows the browser's own HTTP cache to reuse the response for the same TTL window without re-requesting, while `private` prevents shared/CDN caches from storing a token-gated response.
- `Accept-Ranges: bytes` — advertises Range support.

Video requests carrying a `Range` header are honored and answered with `206 Partial Content` and the appropriate `Content-Range`, so the browser's native video player can seek without downloading the full file up front — the same Range-handling behavior already implemented for the public-share byte-proxy.

---

## 8. What Is — and Isn't — Proxied

When `MEDIA_PROXY_ENABLED=true` (default), these browser-facing URL fields are emitted as relative `/api/media/blob?...` URLs instead of direct provider presigned URLs:

- `thumbnailUrl` — grid views, search results, burst groups, duplicate groups, face thumbnails, person cover faces.
- `downloadUrl` — `GET /api/media/:id` (lightbox full-resolution image, video `<source>`, the explicit download link/button).
- `previewUrl` — duplicate-group member preview.

**Deliberately NOT proxied** — these remain real, direct provider presigned URLs, fetched by clients that are not subject to the browser-`<img>`/`<video>` constraint and are not the paths a browser-only middlebox like Zscaler intercepts in the same way:

- Multipart upload part URLs and upload-init URLs (client uploads bytes directly to the provider).
- Admin/CLI object download (`storage/objects/*`).
- Backup read/write paths.
- Storage-migration server-to-server copy (provider-to-provider, never touches a browser).
- The existing public-share byte-proxy (`GET /api/public/shares/:token/media/:idx`) — unchanged; it already proxies through the API for unrelated reasons (see `public-sharing.md` §5) and was not affected by the Zscaler issue since it was already same-origin.

---

## 9. Bytes-Through-VPS Trade-off

Routing browser-facing media through the API moves bandwidth and CPU (stream pass-through) from a direct browser↔storage-provider path onto the application VPS. This is an explicit, accepted trade-off:

- **Thumbnails**: negligible — small payloads, and the whole point of a thumbnail is to be cheap to serve repeatedly.
- **Full-resolution originals and video**: heavier — these can be tens to hundreds of megabytes, and video in particular benefits from Range-request seeking, which means multiple partial requests per playback session all passing through the VPS instead of directly from R2's edge network.

Operators running MemoriaHub on a bandwidth- or CPU-constrained VPS (see the Bulk Import Tuning guidance in `CLAUDE.md`) should budget for this when sizing infrastructure, particularly if the user base does a lot of video viewing. The [§11 revert switch](#11-revert-switch) exists specifically so this trade-off is not permanent or irreversible if it turns out to be the wrong call for a given deployment.

---

## 10. Future Option: Cloudflare Worker

A lower-cost alternative considered but not implemented in this pass: terminate the signed-URL verification in a **Cloudflare Worker** (or equivalent edge function) sitting in front of R2, rather than routing bytes through the application VPS at all. The Worker would perform the same HMAC check described in [§5](#5-token-generation-and-signing)–[§6](#6-validation-and-status-codes) at Cloudflare's edge, then serve the R2 object directly from edge infrastructure — same-origin from the browser's perspective (a `*.yourdomain.com` Worker route), zero VPS bandwidth/CPU cost, and Cloudflare's edge network handles Range requests and caching natively.

This was not pursued for the initial fix because it requires provisioning and deploying a separate edge-function component (outside the NestJS API), coupling the fix to being on Cloudflare specifically (the multi-provider storage abstraction in `storage-providers.md` supports S3, R2, and local disk — a Worker-based fix would need a different mechanism for non-R2/non-Cloudflare deployments), and the VPS-proxy fix was sufficient to unblock affected users immediately. It remains a candidate future optimization if VPS bandwidth/CPU from the current approach becomes a bottleneck (see [§9](#9-bytes-through-vps-trade-off)).

---

## 11. Revert Switch

`MEDIA_PROXY_ENABLED` (default `true`) is a single environment-variable kill switch. Setting it to `false` reverts URL generation to the pre-fix behavior: `thumbnailUrl`, `downloadUrl`, and `previewUrl` are emitted as direct provider presigned URLs again, and `GET /api/media/blob` is simply not referenced by any generated URL (the endpoint itself remains registered and functional, it's just unused). No code deploy, migration, or restart-order dependency is required beyond restarting the API process to pick up the new environment value — this is the same pattern used elsewhere in the codebase for feature-flag-style env kill-switches (e.g. `FACE_AUTO_DETECT`, `AUTO_TAG_ENABLED`).

Use this switch to roll back quickly if the proxy causes unexpected VPS load (see [§9](#9-bytes-through-vps-trade-off)) or any other regression, without needing to revert the underlying code change.

---

## 12. EXIF / GPS Limitation

Identical to the limitation already documented for public shares (`public-sharing.md` §7): `GET /api/media/blob` streams the **raw original file** bytes from storage. It does not decode, re-encode, or strip embedded metadata before sending.

A photo containing GPS coordinates in its EXIF headers will still contain those coordinates in the bytes served by the proxy, even though the proxy itself adds no metadata to the HTTP response beyond standard headers. This is a pre-existing property of serving original files and is unchanged by this feature — the proxy's purpose is to fix the delivery transport (same-origin, signature scheme resilient to query-param injection), not to change what bytes are served.

If file-level EXIF/GPS stripping is required in the future, the same approach outlined in `public-sharing.md` §7 applies: pipe the byte stream through `apps/api/src/storage/processing/` (the `sharp`-based pipeline already used for orientation normalization) before writing to the HTTP response, with a separate ffmpeg-based approach needed for video.

---

## 13. Configuration Reference

All three variables live in `apps/api/src/config/configuration.ts` under the `media` section.

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEDIA_PROXY_ENABLED` | `true` | Master switch. `true` = emit `/api/media/blob` URLs for browser-facing media; `false` = emit direct provider presigned URLs (pre-fix behavior / instant revert). |
| `MEDIA_PROXY_URL_TTL_SECONDS` | `3600` | TTL in seconds for the signed proxy URL's `exp` claim, and also the value used for the `Cache-Control: private, max-age=<ttl>` response header on served bytes. |
| `MEDIA_URL_SIGNING_SECRET` | falls back to `JWT_SECRET` | HMAC-SHA256 secret for signing/verifying `k`+`exp` tokens. Setting a dedicated secret (rather than relying on the `JWT_SECRET` fallback) is recommended in production so that rotating one secret does not force rotation of the other. |

---

## 14. API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/media/blob?k=&exp=&sig=` | `@Public()` — HMAC token in query string is the authorization | Stream media bytes for a single storage key; supports video Range requests |

**Example URL emitted by the API:**

```
/api/media/blob?k=circles%2F...%2Foriginal.jpg&exp=1751800000&sig=9f3a1c...
```

---

## 15. Key Files

| Path | Role |
|------|------|
| `apps/api/src/config/configuration.ts` | `media.proxyEnabled`, `media.proxyUrlTtlSeconds`, `media.urlSigningSecret` config keys |
| `apps/api/src/media/media-blob.controller.ts` | `GET /api/media/blob` handler — signature verification, streaming, Range support |
| `apps/api/src/media/signing/media-url-signing.service.ts` | HMAC token generation used when building `thumbnailUrl`/`downloadUrl`/`previewUrl` |
| `apps/api/src/storage/providers/storage-provider.resolver.ts` | Shared provider/object resolution reused by the proxy handler |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification documenting the Zscaler `_sm_nck` fix and same-origin byte-proxy design |
