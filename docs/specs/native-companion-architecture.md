# Native Companion Architecture (PWA in a TWA plus a native module)

> **Status:** specified, implementation in progress (epic #498) · **Code (planned):** `apps/android/`, `apps/api/src/media-sync/`, `apps/api/src/android-app/`, `apps/api/src/device-auth/`, `apps/web/src/utils/twa.ts`, `apps/cli/src/android/` · **API:** `/api/media-sync/*`, `/api/android-app/*`, `/api/well-known/assetlinks.json`, `/api/auth/device/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/android` · **Feature spec:** [android-media-sync.md](android-media-sync.md) · **Recipe:** [section 4](#4-extending-it-in-a-fork)

The Android app is MemoriaHub's web app in a Trusted Web Activity (TWA) plus a small native Kotlin module, coordinated through the server. The PWA stays the product. The native module exists only to reach on-device APIs the web cannot: today, MediaStore (read the phone's photos and videos) and WorkManager (upload them in the background, resumably). The two halves share no process-level bridge. They meet through a launch URL, a deep link, the server's REST API, a device-flow pairing and Digital Asset Links. This spec explains why it is built this way and how to add the next native capability. The feature itself (payloads, ledger state machine, upload sequence, diagnostics) is the contract in [android-media-sync.md](android-media-sync.md).

This design is a port of the architecture proven in the `marinoscar/evopath` template (`docs/specs/native-companion-architecture.md`), adapted to MemoriaHub's identity, permissions and upload path. It replaces the retired standalone Android app (see [the appendix of android-media-sync.md](android-media-sync.md#appendix-a-notes-salvaged-from-the-legacy-app)).

## 1. Purpose

- **What it is.**
  - The architectural pattern behind `apps/android/`, written so an engineer can replicate it for a new native capability.
  - The record of the options that were weighed and why a TWA plus native module won.
  - The inventory of the five coordination channels, their failure modes and where each surfaces in diagnostics.
- **What it is not.**
  - Not the Media Sync feature spec: see [android-media-sync.md](android-media-sync.md).
  - Not an operator guide: the runbooks are `docs/runbooks/android-app.md` and `docs/runbooks/android-release.md` (written in #519).
  - Not a second client. The native module has no business logic of its own beyond reading the device API, shaping a payload, uploading and retrying.
- **Problem it solves.**
  - A PWA cannot enumerate a phone's media folders, cannot watch for new photos in the background and cannot upload multi-gigabyte videos reliably when the tab is closed. Android's MediaStore, WorkManager and foreground services have no web equivalent.
  - The product must still be a web app: one UI, one release path, Web Push and the same sign-in everywhere.
  - So the phone needs a small native piece that reads MediaStore locally and pushes to the server, while the web app keeps every screen and every rule.

## 2. How it works

### 2.1 Options considered

| Option | Reaches MediaStore and background upload | Keeps the web app as the product | Sign-in | Verdict |
|---|---|---|---|---|
| Pure PWA | No: browsers expose no folder enumeration or background file watcher | Yes | Browser session | Impossible |
| Server pulls from the phone | No: the phone is not reachable | Yes | n/a | Impossible |
| Capacitor or other WebView wrapper | Yes, through a plugin | Partly: the UI runs in an embedded WebView, not Chrome | Google blocks OAuth in embedded user agents (`disallowed_useragent`); a WebView also loses the real Chrome PWA features | Rejected |
| Standalone native app (the retired v1 app) | Yes | No: a second UI to build and keep in sync | Own login and token refresh | Rejected: two UIs, two logins, a 7-day session that had to be refreshed by hand |
| **TWA plus native module** | **Yes, in the native module** | **Yes, the TWA is the real Chrome PWA** | **Shared browser session; native side uses a paired token** | **Chosen** |

- **Capacitor and WebView wrappers.** Google's sign-in refuses embedded user agents ([modernizing OAuth in native apps](https://developers.googleblog.com/2016/08/modernizing-oauth-interactions-in-native-apps.html), [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)), and MemoriaHub signs in with Google. A WebView also has its own cookie jar and service-worker behaviour, so it is a second browser to test and would duplicate the PWA's install, push and storage behaviour. A bridge to native code would be required, with the attack surface that implies.
- **Standalone native app.** MemoriaHub shipped one (`cr.marin.memoriahub`). It carried its own UI for everything, authenticated with a 7-day JWT whose refresh cookie it replayed manually, and had no release or update path. Maintaining a second UI for browsing and settings was the cost; the web already does all of that.
- **TWA versus WebView.**

| | TWA | WebView |
|---|---|---|
| Engine | The user's real Chrome (or another TWA-capable browser) | An embedded renderer inside the app |
| Cookies and storage | Shared with the browser | Private to the app |
| Service worker, Web Push, install state | The browser's own | Not the browser's |
| Trust | Verified by Digital Asset Links between the site and the app's signing key | None needed, and none given |
| Chrome UI | No URL bar once verified | App-defined |
| JavaScript bridge | None | Possible, and a larger attack surface |

The TWA is the web app, displayed full screen with brand status and navigation bars and a splash screen. That is what lets this architecture say "the PWA is the product" without qualification. The cost is that a TWA cannot call into Kotlin, which is why the coordination channels below exist ([section 2.4](#24-the-five-coordination-channels)).

### 2.2 Architecture

```
 Phone                                                       Server (same origin)
┌──────────────────────────────────────────────────┐
│ package memoriahub.marin.cr                      │
│                                                  │
│  ┌────────────────────┐   ┌────────────────────┐ │
│  │ TwaLauncherActivity│   │ MediaSyncActivity  │ │        GET /.well-known/assetlinks.json
│  │ (androidbrowser-   │   │ Compose UI: pair,  │ │ ◄───────────────────────────────────────┐
│  │  helper) opens     │   │ folders, network,  │ │                                         │
│  │ <server>/?source=  │   │ files, diagnostics │ │                                         │
│  │ twa&appVersion=…   │   └─────────┬──────────┘ │        Authorization: Bearer pat_…      │
│  └─────────┬──────────┘             │            │ ───────────────────────────────────────►│
│            │ renders the PWA    ┌───▼──────────┐ │   POST /api/media-sync/devices          │
│            │ in Chrome          │ WorkManager  │ │   POST …/devices/:id/checkin            │
│            ▼                    │ MediaSync-   │ │   POST …/devices/:id/diagnostics        │
│   ┌────────────────┐            │ Worker       │ │   POST /api/storage/objects/upload/*    │
│   │ PWA (Chrome)   │ deep link  └───┬──────────┘ │   POST /api/media                       │
│   │ session cookie │ memoriahub://  │ reads      │   GET  /api/android-app/releases/latest │
│   └──────┬─────────┘ media-sync     ▼            │                                         │
│          │ ───────────────────────► MediaStore    │                                         │
│          │                        + Room ledger   │                                         │
└──────────┼───────────────────────────────────────┘                                         │
           │ REST with the browser session (JWT)                    nginx ──► api ───────────┘
           └──────────────────────────────────────────────────────────►  │
                                                                         ▼
                              media_sync_devices · runs · diagnostic reports · media_items
                              object storage: uploaded media, and android-releases/<releaseId>.apk
```

| Component | Role | Code (planned) |
|---|---|---|
| TWA launcher | Opens the PWA at the configured server with the launch flags; shows a setup screen when no server is set | `apps/android/app/src/main/java/memoriahub/marin/cr/TwaLauncherActivity.kt` |
| Native Media Sync activity | Pairing, folders, network policy, file list, diagnostics, update card | `…/mediasync/MediaSyncActivity.kt` and the screens beside it |
| Pairing | RFC 8628 device flow, token storage, device registration | `…/pairing/PairingManager.kt`, `…/pairing/DeviceFlow.kt`, `…/auth/TokenStore.kt` |
| Media discovery and ledger | MediaStore folder inventory, incremental scan, Room per-file ledger | `…/media/`, `…/ledger/` |
| Upload engine | Hash, dedup pre-check, resumable multipart, retry and backoff, network policy | `…/upload/UploadEngine.kt` |
| WorkManager workers | Periodic catch-up, content-URI trigger, expedited "now", check-in before and after | `…/sync/MediaSyncWorker.kt`, `…/sync/MediaSyncScheduler.kt` |
| Diagnostics | Self-test, redacted rolling log, report upload | `…/diagnostics/SelfTest.kt`, `…/diagnostics/Checks.kt`, `…/diagnostics/AppLog.kt` |
| Update check | Asks the server for a newer release; opens a signed download link | `…/update/` |
| PWA | Every user-facing screen; detects the TWA; offers the deep link; edits the desired config; reads devices and reports over REST | `apps/web/src/utils/twa.ts`, `apps/web/src/pages/MediaSyncPage.tsx`, `apps/web/src/components/common/AndroidUpdateBanner.tsx` |
| API | Device registry, desired config, check-in, assetlinks, hosted releases, device flow, the existing upload endpoints | `apps/api/src/media-sync/`, `apps/api/src/android-app/`, `apps/api/src/device-auth/`, `apps/api/src/storage/` |
| Object storage | Holds uploaded media and the hosted APKs under `android-releases/` | [storage-providers.md](storage-providers.md) |
| CLI | Doctor, keystore, version, build, publish, release, TUI | `apps/cli/src/commands/android.ts`, `apps/cli/src/android/` |

Both Activities live in one package, so one install, one signing key and one Digital Asset Links statement cover the whole app.

### 2.3 Why there is no JavaScript to Kotlin bridge

The TWA has no `addJavascriptInterface`, no `postMessage` channel and no custom scheme the page can call synchronously; `apps/android/app/src/main` contains no `WebView`. This is deliberate:

- A TWA is Chrome. Chrome exposes no way to hand a page a native object, so a bridge would require abandoning the TWA for a WebView ([section 2.1](#21-options-considered)).
- A bridge turns every XSS in the web app into native code execution with the app's permissions, including read access to the phone's whole photo library. Without one, a compromised page can reach only what its own session can reach over REST.
- The two halves stay independently deployable. The web ships with every server deploy; the APK ships only when native code changes ([section 2.7](#27-lifecycle-and-releases)).
- The cost is that nothing is synchronous. The web asks, the server mediates, the phone answers later. Features that need a native answer inside one click do not fit this pattern ([section 2.9](#29-trade-offs-and-limits)).

### 2.4 The five coordination channels

| # | Channel | Direction | Carries |
|---|---|---|---|
| a | Launch URL query | native → web | "I am the app", the app version |
| b | Deep link | web → native | "open this native screen" or "do this now" |
| c | The server as hub | native ⇄ web, through REST | desired config, commands, stats, runs, diagnostics, releases |
| d | Device-flow pairing in a Custom Tab | web session → native credential | a `pat_` token |
| e | Digital Asset Links | server → Chrome | trust: full-screen mode, no URL bar |

**a. Launch URL (`?source=twa&appVersion=&appVersionCode=`).**

- **Mechanism.** `TwaLauncherActivity.getLaunchingUrl()` builds `<server>/?source=twa&appVersion=<versionName>&appVersionCode=<versionCode>` through `ServerUrls.twaLaunchUrl`. The manifest's `DEFAULT_URL` is only a placeholder, so one APK works against any deployment. The PWA calls `captureTwaLaunch()` once at startup (`main.tsx`) and keeps the flags in `sessionStorage` under `memoriahub.twa`, `memoriahub.twa.appVersion` and `memoriahub.twa.appVersionCode`, then strips them from the URL (`apps/web/src/utils/twa.ts`). `isRunningInTwa()` is true for the stored flag or an `android-app://` referrer; `getInstalledAppVersion()` returns the build.
- **Used for.** Offering the deep links ("Open Media sync on this phone" on `/settings/media-sync`) and showing the update banner. Presentation only: it grants nothing.
- **Failure mode.** The query string disappears after the first navigation and `sessionStorage` can be blocked. The referrer check covers a missed flag; an older build that sends no `appVersionCode` simply shows no version. The flag can be forged by anyone, which is why it never gates an API.
- **Diagnostics.** The phone's `app.version` check reports the build; the web's Media Sync page shows `appVersionCode` from the device row.

**b. Deep link (`memoriahub://media-sync[/path][?action=…]`).**

- **Mechanism.** `MediaSyncActivity` declares a `VIEW` intent filter with scheme `memoriahub` and host `media-sync` (`AndroidManifest.xml`); the web app renders links from `apps/web/src/utils/androidIdentity.ts` (`mediaSyncDeepLink(path?, action?)`). Static launcher shortcuts open the same activity. The table of paths and actions is in [android-media-sync.md section 12.2](android-media-sync.md#122-deep-links).
- **Actions.** A deep link may carry `?action=apply|sync|retry|pause|resume`. These make the web's "Apply now on this phone" instant inside the TWA, with no push infrastructure. The permission grant itself is the one thing a link cannot do; Android requires the user to grant it in the native UI.
- **Failure mode.** Outside the app the link has no handler and nothing happens, so the web offers it only when `isRunningInTwa()`.
- **Diagnostics.** None: it is a navigation. A screen the link reaches is the diagnostics surface for everything else.

**c. The server as hub.**

- **Mechanism.** The native module posts to `/api/media-sync/devices`, `…/devices/:id/checkin` and `…/devices/:id/diagnostics` with its token, and uploads media through the existing storage and media endpoints. The PWA reads devices, runs and reports with the browser session and edits the **desired config** (folders, network policy, target circle, pause, commands). The phone pulls that config on every check-in. Neither half talks to the other.
- **Failure mode.** A phone offline or backing off leaves the server stale: the web shows "Changes pending, will apply next time the phone checks in" while `appliedConfigVersion < configVersion`. A check-in that arrives late is harmless because every write is idempotent ([section 2.6](#26-data-flow-and-correctness-patterns)).
- **Diagnostics.** `server.reachable`, `auth.valid`, `api.connection` and `sync.last` cover reach, credentials and the last run; uploaded reports show up on `/settings/media-sync`.

**d. Pairing through the device flow.**

- **Mechanism.** `PairingManager` requests a code (`POST /api/auth/device/code`, `clientInfo.tokenType: "pat"`, `clientInfo.returnUri: "memoriahub://media-sync/paired"`), shows the user code and opens the activation page in a Custom Tab. A Custom Tab shares Chrome's cookie jar, the same jar the TWA uses, so the user is already signed in and only approves. The app polls `POST /api/auth/device/token` (RFC 8628) and receives a `pat_` token, then registers the phone with `POST /api/media-sync/devices`. The token is stored in encrypted preferences as soon as it arrives, so a failed registration retries without a second approval. After approval the activation page redirects to the `returnUri`, bringing the user back to the app.
- **Re-pair.** Registering with a new PAT revokes the previously linked PAT in the same transaction and reuses the device row (same `installationId`). Unpairing revokes the PAT and marks the device `revoked`.
- **Failure mode.** The user is signed out of Chrome: the Custom Tab shows the normal sign-in, then the approval. No browser at all: the code and URL stay on screen. A token that expires or is revoked answers `401`: the app stops syncing and posts a re-pair notification. A `409 DEVICE_REVOKED` makes it forget the pairing.
- **Diagnostics.** `pairing.token` (present, under 14 days to expiry warns, expired fails) and `auth.valid` (`401` means re-pair, `404` or `409` means connect again).

**e. Digital Asset Links trust.**

- **Mechanism.** Chrome opens the TWA without a URL bar only if `/.well-known/assetlinks.json` lists the app's package and signing SHA-256. The system setting `android_app` holds the trusted list; `GET /api/well-known/assetlinks.json` serves it as a bare array, public and exempt from the maintenance window, and nginx maps `/.well-known/assetlinks.json` to it. Each phone reports its package and fingerprint at registration; an admin trusts it at `/admin/settings/android`, and making a release current trusts its key automatically.
- **Failure mode.** An untrusted or mistyped fingerprint, or a key that changed, leaves the app working but with a URL bar. Chrome caches a failed verification, which is why the document survives maintenance windows. Package names are case-sensitive: `memoriahub.marin.cr` is all lowercase everywhere.
- **Diagnostics.** The phone's `twa.verification` check (fetches the document and compares; only ever warns) and the server's Doctor check `android.assetlinks` ([doctor.md](doctor.md)).

### 2.5 Identity and security model

- **Two independent credentials.**

| | Browser (PWA) | Native module |
|---|---|---|
| Credential | Access JWT in memory plus HttpOnly `refresh_token` cookie | `pat_` token in `EncryptedSharedPreferences` (`auth/TokenStore.kt`) |
| Obtained by | Google sign-in in Chrome | Device flow approved in that same Chrome |
| Lifetime | 15 minutes, rotated refresh | `DEVICE_PAT_TTL_DAYS`, default 90 |
| Revoked by | Sign out | Unpair, re-pair, or the Access Tokens page |
| Reaches | Everything the user may do | Whatever the PAT's owner may do, used only for the media-sync, upload, media-registration and release routes |

- **Revocation is per device.** A device row links its PAT; revoking the device revokes the token. A re-pair revokes the old token in the same transaction. Either way a lost or reset phone does not keep a valid credential.
- **Owner-scoped routes answer 404.** Another user's device, run or report is `404`, never `403`, so ids cannot be enumerated. A PAT linked to one device is accepted only for that device's id on the device-scoped write routes, so a phone can never reconfigure or impersonate another phone.
- **Attribution is tied to a registered device.** `POST /api/media` accepts `sourceDeviceId` for `source: 'android'` only when it names an **active** device owned by the caller. Anything the payload claims about the provider, owner or circle is validated by the server, never trusted.
- **No token in logs or reports.** `AppLog` redacts `pat_…`, `Bearer …` and any URL query string (presigned URLs carry credentials) before storing; the serialized report is scrubbed and trimmed below 200 KB; the API client logs method, path, status and code, never a body. The server logs ids and counts, never tokens.
- **Backups are disabled.** `android:allowBackup="false"` plus data-extraction rules exclude every preference file and Room database, so a restored phone never resurrects a stale token or ledger.
- **The signing key is the trust anchor.** Digital Asset Links bind the site to the key. Lose the keystore and installed copies can never be updated; leak it and someone else can ship an APK Chrome will open full screen against your server. Keep it out of every checkout (`~/.memoriahub/android/`, mode 0700, backed up by the operator).
- **No bridge, smaller surface.** See [section 2.3](#23-why-there-is-no-javascript-to-kotlin-bridge): the page cannot call native code, and the native module never loads web content.
- **The reported fingerprint is informational.** Only an administrator's trust decision, or making a release current, changes `assetlinks.json`.
- **Side channels the page cannot spoof.** The server never trusts `?source=twa` or the app version for authorization; both are presentation hints.

Details of credential kinds: [SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md), [DEVICE-AUTH.md](../DEVICE-AUTH.md), [personal-access-tokens.md](../personal-access-tokens.md).

### 2.6 Data flow and correctness patterns

These are the patterns to copy for the next capability. The Media Sync specifics live in [android-media-sync.md](android-media-sync.md).

- **Desired state with a version.** Behaviour the user configures lives on the server as a JSON document with a monotonically increasing `configVersion`. Whoever edits it (the web, or the phone's own native screens) bumps the version; the phone pulls it on every check-in and reports `appliedConfigVersion` back, so "changes pending" is observable and no push channel is needed. Commands (pause, resume, retry failed, sync now) are generation counters inside the same document, so a late or repeated delivery cannot fire twice.
- **The device holds the per-item truth.** The phone's Room ledger is authoritative for each file. The server stores aggregates and a bounded sample of failures. Server idempotency does not depend on the ledger: `POST /api/media` deduplicates on `(circle_id, content_hash)`, so a wiped ledger or a re-sent file produces no duplicate.
- **Run ledger.** The run row is inserted even for a failed, skipped or empty run (newest 200 kept per device). The phone also keeps its last 50 runs. "What happened at 03:00?" has an answer on both sides.
- **Diagnostics upload.** The phone runs a self-test whose checks are independent, timed-out and never throw; the report is uploaded on demand and, after a failed or partial run, automatically at most every 6 hours (newest 20 kept per device). The web renders it. Pure verdict functions in `diagnostics/Checks.kt` keep the checks unit-testable on the JVM.
- **Permission-loss skip.** A run without media permission reads nothing and reports a `skipped` run with `errorCode: MEDIA_PERMISSION_MISSING` rather than failing silently or treating an empty scan as "everything was deleted". At most one notification per 24 hours asks for the permission. Copy this shape for any capability whose access can be revoked.
- **Constant memory for large payloads.** File bytes stream from a content URI through a range-limited request body straight to storage; neither the phone nor the API buffers a part. The same rule holds for the APK upload on the server.
- **Interfaces at every seam.** The platform API (MediaStore, WorkManager, connectivity, battery) sits behind a Kotlin interface so the logic runs on the JVM in unit tests. There is no DI framework: manual lazy singletons in `MobileApplication`.
- **One request, one transaction, no queue job.** A check-in ends with its response, so the queue rules for long-running work do not apply ([job-queue.md](job-queue.md#all-long-running-work-is-a-job)). Work that outlives the request (thumbnails, metadata, enrichment of an uploaded photo) is a queue job the existing media pipeline already enqueues.

### 2.7 Lifecycle and releases

| Change | Needs a new APK | Needs only a server deploy |
|---|---|---|
| Any PWA screen, copy, rule or API change | No | Yes |
| New or changed server-side validation, retention, config defaults | No | Yes (if the contract is unchanged) |
| Trusting another build (`/admin/settings/android`) | No | No (a setting) |
| A new native permission, reader, worker or screen | Yes | Also, to accept the new payload |
| A new payload field the server must read | Yes | Yes, server first |
| Renaming the product (identity) | Yes: the package changes, so it is a new app | Yes |

- **Version.** `apps/android/version.properties` holds `versionName` and `versionCode`. `versionCode` must strictly increase for every published APK, because Android refuses to install a lower code over a higher one; the server refuses a duplicate (`409`, `details.reason: RELEASE_VERSION_EXISTS`) or a non-newer current release (`409 RELEASE_VERSION_NOT_NEWER`, unless forced).
- **Release paths.** All run the same stages (bump, build and sign, upload, make current). The **core path is the CLI**: `memoriahub android release --bump patch` (#517). The others are the terminal menu's Android screen, the upload form at `/admin/settings/android` (#516) and the CI workflow `.github/workflows/android.yml`, which publishes only to the rolling GitHub prerelease `android-latest`, never to a server (#518). There is no `deploy` command and no `deploy --with-android`.
- **Server-hosted releases.** The deployment stores the APK in object storage (`android-releases/<releaseId>.apk`), serves it through a signed 10-minute same-origin link (`POST /api/android-app/releases/:id/download-link`, then `GET /api/android-app/download/<token>`) so the system downloader needs no `Authorization` header, and tells each device whether it is behind. nginx has exact-match locations for the upload and download paths.
- **In-app update check.** On app open and Hub resume, at most every 12 hours and only while paired, `update/` asks `GET /api/android-app/releases/latest` and shows the Update card when `versionCode` is higher. The PWA shows `AndroidUpdateBanner` inside the TWA when the launch URL's `appVersionCode` is behind the current release. There is no push notification for updates.
- **Identity from `identity.properties`.** `apps/android/app/build.gradle.kts` reads `apps/android/identity.properties` and derives the label, the deep-link scheme, the brand colours and the storage prefix; `BuildConfig` carries them into user-facing text. The web app mirrors the values in `apps/web/src/utils/androidIdentity.ts`, guarded by a unit test that reads the properties file. The brand colours equal `THEME_COLOR` and `BACKGROUND_COLOR` in `apps/web/pwa/manifest.ts`.

### 2.8 Where each concern lives

| Concern | Native | Web | Server |
|---|---|---|---|
| Reads the device API (MediaStore) | Yes | No | No |
| Business rules (dedup, validation, circle permissions) | No | No | Yes |
| User interface for the data | Pairing, folders, network, files, diagnostics only | Everything else | n/a |
| Desired config | Edits through REST, applies on check-in | Edits through REST | Stores, versions, validates |
| Authorization | Presents a PAT | Presents a JWT | Decides |
| Retention | Local ledger and log caps | No | Runs, reports, releases |

### 2.9 Trade-offs and limits

- **Android only.** No iOS equivalent is built; a TWA is an Android concept.
- **A TWA-capable browser is required.** Chrome (or another browser that supports TWAs) must be installed and current. Without one the launcher falls back to a Custom Tab with a URL bar.
- **Two logins.** The browser session and the paired token are separate; the Custom Tab flow makes the second a single approval, but a user can still have one without the other. Expiry of the PAT means re-pairing.
- **No synchronous web to native calls.** The web cannot ask the phone anything and wait. Design features as "the phone pushes, the web reads, the web edits desired state, the phone pulls".
- **Sideload versus Play.** The app is distributed from the deployment (or a GitHub prerelease), not Google Play. Play restricts `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` to apps whose core purpose needs broad access and otherwise expects the system photo picker; a sideloaded deployment is not subject to that review. A Play listing would need the declaration or a picker-based design (out of scope).
- **Background limits.** WorkManager is best-effort: Doze, App Standby buckets and vendor battery savers delay or skip runs; content-URI triggers are batched, not instant; Android 15 caps `dataSync` foreground services at about 6 hours per day. The app compensates with a 6-hour periodic catch-up, an app-open trigger, an expedited "Sync now", a resumable ledger, skip reporting and diagnostics (`battery.optimization`, `media.trigger`, `work.periodic`).
- **No instant updates for native code.** Native changes ship only with an APK; users learn of one on their next app open.
- **Digital Asset Links are cached.** A newly trusted key takes up to about five minutes, and Chrome remembers a failed verification.

## 3. Configuration and permissions

- **Env vars:** none new. `DEVICE_PAT_TTL_DAYS` (existing, default 90) is the pairing token lifetime. The signed download link key derives from the existing `SECRETS_ENCRYPTION_KEY` through `deriveSubKey('android-app-download')`. Storage is configured at runtime ([storage-providers.md](storage-providers.md)); never add an environment variable for it.
- **System setting:** `android_app` (`trustedApps`, at most 10), its own `system_settings` row, edited at `/admin/settings/android`.
- **Build inputs:** `apps/android/identity.properties`, `apps/android/version.properties`, the optional Gradle property `app.serverUrl`, and the signing environment variables ([apps/android/README.md](../../apps/android/README.md), written in #508).
- **Permissions and routes:** owned by [android-media-sync.md section 16](android-media-sync.md#16-rbac-and-security); the generated reference is `/api/docs`. No new RBAC permission and no new environment variable is added by this feature.

| Channel | Route or artifact | Auth |
|---|---|---|
| a, b | none (launch URL, intent filter) | none |
| c | `/api/media-sync/devices/*`, `/api/storage/objects/*`, `/api/media` | PAT or JWT, `media:read` / `media:write` (and `storage:write` for the upload endpoints) |
| d | `/api/auth/device/code`, `/api/auth/device/token`, activation page | device flow; activation needs the user's session |
| e | `/api/well-known/assetlinks.json` | public, maintenance-exempt |

## 4. Extending it in a fork

### 4.1 Recipe: adding a new native capability

Work through the layers in this order. Each step names where Media Sync does the same thing.

1. **Decide it needs native code.** If a web API (Web Push, File System Access, Web Share) can do it, use the PWA. Native code is for on-device APIs with no web or cloud equivalent. State the rule in the capability's spec.
2. **Manifest.** Add the `<uses-permission>` entries to `AndroidManifest.xml`, and a `<queries>` entry for any package you must resolve. Add an Activity or alias for any rationale screen the platform requires. Request each permission at the moment the user enables the feature, and write the rationale in the user's terms. Mind version-specific rules (`maxSdkVersion`, partial grants, foreground-service types).
3. **Native reader and worker.** Put the platform API behind a gateway interface (see `media/MediaGateway.kt`) so the engine is unit-testable on the JVM. Put background work in a `CoroutineWorker` with a unique work name, constraints rebuilt from the current config, exponential backoff and an app-open trigger (`sync/MediaSyncScheduler.kt`). Handle permission loss as a reported `skipped` run, not a crash.
4. **Payload contract.** Define the wire shape once, in a Zod schema on the server (`apps/api/src/media-sync/dto/`) and a matching `@Serializable` class on the phone. Include a run envelope (trigger, status, counts, `errorCode`). Version it by adding optional fields; the server accepts the old shape while old APKs exist (deploy the server first).
5. **API ingestion with idempotency.**
   - Register the phone as a device (the `media_sync_devices` row is reusable) and derive anything provider-like on the server from the device id in the URL, never from the payload.
   - Make writes idempotent with an owned key (here the existing `(circle_id, content_hash)`; for new rows, a raw-SQL partial unique index written by hand in the migration, never a `@@unique`).
   - Anything long-running is a queue job ([job-queue.md](job-queue.md)); AI work follows the AI platform rules.
   - Extend the user-data purge if a new table references a user ([user-data-reset.md](user-data-reset.md)).
6. **Desired config and web surfaces.** Add the fields to the config schema (additive, with a default), expose them in the web editor, reuse `isRunningInTwa()` to offer the deep link, and extend the existing `/settings/media-sync` page rather than adding a page. Register any new user-settings card and route in the registries ([settings-ui.md](settings-ui.md)).
7. **Diagnostics checks.** Add one pure check function per failure you can name to `diagnostics/Checks.kt`, register it in `SelfTest`, and list it in the spec's check table. Each check: `{ id, label, status, detail, remedy?, data? }`, own timeout, never throws.
8. **Trust and release.** A new capability ships in a new APK: bump `version.properties`, release it (`memoriahub android release`), and confirm the signing key is still the trusted one (`twa.verification`, Doctor `android.assetlinks`).
9. **Docs.** Write a feature spec, add the check rows and the runbook troubleshooting entries, and link both from [CLAUDE.md](../../CLAUDE.md).
10. **Tests.**
    - Android JVM unit tests: mapping, scheduling constraints, payload building, check verdicts, redaction (`./gradlew testDebugUnitTest` in `apps/android`).
    - API: service specs, an HTTP integration spec through the real guards, a `*.db.spec.ts` where a mocked Prisma cannot prove the behaviour ([TESTING.md](../TESTING.md)).
    - Web: component tests for the surfaces.

### 4.2 Worked example: automatic photo and video upload (shipped as Media Sync)

[android-media-sync.md](android-media-sync.md) is this recipe applied to a capability with very different constraints from small rows: large files, a huge library, background execution and a user who wants control. The mapping:

| Layer | Design (details in the feature spec) |
|---|---|
| Permission | `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` on Android 13+ (`READ_EXTERNAL_STORAGE` up to 12). Android 14 partial access ("Select photos and videos") is a degraded grant reported as `permission: 'partial'`; the app must work with a subset. `ACCESS_MEDIA_LOCATION` keeps EXIF GPS in the uploaded bytes. |
| Discovery | A WorkManager content-URI trigger on `MediaStore.Images` and `MediaStore.Video` for new items, plus a periodic 6-hour catch-up that queries MediaStore by generation (`GENERATION_MODIFIED`, API 30+) because triggers can be missed. A Room ledger remembers every file. |
| Constraints | `UNMETERED` ("Wi-Fi only", the default) or `CONNECTED` ("Wi-Fi and mobile data"), plus optional "only while charging". Cellular upload is an explicit opt-in and is re-checked between parts. |
| Transfer | The existing resumable S3 multipart endpoints with presigned URLs minted per part, streamed straight to object storage and never buffered by the API or the phone; a part route proxied by the API for the `local` provider. The phone stores the upload id and the confirmed parts so a retry resumes. |
| Foreground work | A `dataSync` foreground service with a progress notification and a Pause action once real work is queued; Android 15's roughly 6 hours per day limit is handled as a `partial` run that resumes later. |
| Payload contract | A check-in with stats, folder inventory and the run envelope; per-file registration is the ordinary `POST /api/media` with `source: 'android'`. |
| Idempotency | `(circle_id, content_hash)` on the server; the phone's ledger on the device. No per-file server table. |
| Reconciliation | None: deleting a photo on the phone never deletes it on the server (non-goal, [android-media-sync.md section 23](android-media-sync.md#23-non-goals)). |
| Post-processing | Thumbnails, EXIF, tagging and the rest are the existing queue jobs enqueued by the media pipeline on registration; the phone does nothing special. |
| Web | `/settings/media-sync` edits the desired config and shows counts, runs and reports; the TWA offers deep links to the native screens. |
| Diagnostics | `media.permission`, `media.folders`, `media.trigger`, `work.periodic`, `network.policy`, `upload.backlog`, `upload.stalled`, `upload.target`, `battery.optimization` and more. |
| Play policy | Sideload only; see [section 2.9](#29-trade-offs-and-limits). |

## 5. Guardrails

Each of these is created by the sub-issue of epic #498 named in parentheses; they are the executable form of this spec.

- `apps/web/src/__tests__/` TWA tests (#515): the TWA-only surfaces (buttons, `AndroidUpdateBanner`, `InstallPrompt` suppression) render only inside the TWA and cost no request elsewhere; `androidIdentity.ts` equals `apps/android/identity.properties`.
- `apps/api/src/media-sync/*.spec.ts` and `apps/api/test/media-sync/*` (#505): register and re-pair PAT revocation, PAT-to-device scoping, config validation, generations, runs and reports trimming, owner-scoped 404, `*.db.spec.ts` for concurrent registration.
- `apps/api/src/android-app/android-app.schema.spec.ts`, `android-app.service.spec.ts` and `apps/api/test/android-app/*` (#503, #504): the trusted list, the public bare-array assetlinks document, version rules, streaming upload, signed download links, one-current partial index (`one-current.db.spec.ts`), nginx locations.
- Storage part-upload specs (#506): API part URLs for the `local` provider, idempotent part PUT, `UPLOAD_PARTS_MISSING`, S3 path unchanged.
- Android JVM unit tests (`apps/android`, `./gradlew testDebugUnitTest`, #508-#514): ledger transitions, scanner cursors, upload engine against MockWebServer, scheduler constraints, API client errors, check verdicts, log redaction, update guard.
- CLI Vitest suites (#517): repo resolution, version edit rules, doctor plan, keystore, build arguments, publish multipart, release pre-checks.
- Doctor `android` section tests (#507).

## 6. Design decisions

- **TWA plus native module, not a WebView wrapper.** Google's sign-in refuses embedded user agents and a wrapper replaces Chrome's PWA behaviour with its own. The TWA is the real PWA; only MediaStore and background upload need Kotlin.
- **No JavaScript bridge.** A bridge needs a WebView and widens the XSS blast radius, here to a phone's whole photo library. Coordination through URLs, intents and REST keeps the halves independent and the page unable to call native code. Rejected: a bridge with an allowlist of methods (still needs a WebView).
- **The server is the hub.** The phone pushes, the web reads and edits desired state, the phone pulls. This also gives multi-device support, history and diagnostics for free. Rejected: the phone writing to the page's storage (no shared storage exists between a Custom Tab, a TWA and a native process that the server does not mediate); FCM push to apply config instantly (needs Firebase; the deep link plus app-open and trigger check-ins are enough for v1).
- **Pairing in a Custom Tab with the device flow.** It reuses an existing, audited flow and the user's signed-in Chrome. Rejected: embedded sign-in (blocked), a shared secret in the launch URL (leaks through logs and history), asking the user to paste a PAT, the legacy JWT-plus-refresh-cookie replay.
- **A separate credential for the native side.** A PAT is scoped to its device, revocable on its own and carries no browser session. The cost is re-pairing on expiry.
- **Desired config on the server, ledger on the device.** The server needs only aggregates; the phone needs per-file state that survives process death, so it is a database there. A per-file server table was rejected for v1.
- **The server hosts the APK.** Self-hosted deployments may be private and users want to download from their own server; the server already knows each device's version. The `android-latest` GitHub prerelease remains a secondary channel.
- **Release from the CLI.** `memoriahub android release` is the one-command path (bump, build, verify, publish, make current) because each self-hosted server publishes its own releases. CI never publishes to a server: that would need a long-lived admin PAT in GitHub secrets for every deployment.
- **Identity from `identity.properties`, mirrored on the web.** A single properties file feeds Gradle, with a test guarding the web mirror, so the package, scheme and colours cannot drift. The cost is that changing `applicationId` after publishing orphans installed copies.

## 7. Verification

```bash
cd apps/api && npx jest --config ./test/jest.config.js media-sync android-app
cd apps/web && npx vitest run twa androidIdentity MediaSync AndroidApp
cd apps/cli && npx vitest run android
cd apps/android && ./gradlew --no-daemon testDebugUnitTest
```

By hand:

1. Install the app, open it, and confirm the PWA opens without a URL bar once the build is trusted (`curl -s <server>/.well-known/assetlinks.json` lists `memoriahub.marin.cr` and the signer).
2. On `/settings/media-sync` inside the app, choose "Open Media sync on this phone" and see the native screen (channel b); in an ordinary browser tab the button is absent.
3. Pair from the native screen, see the Custom Tab open already signed in, approve, return through `memoriahub://media-sync/paired`, and see the device appear on the web (channels c and d).
4. Run Diagnostics on the phone and see `twa.verification`, `auth.valid` and `app.version` pass.
5. Unpair, and see the device `revoked` and its token rejected.

## References

External:

- [Trusted Web Activity overview](https://developer.chrome.com/docs/android/trusted-web-activity)
- [Digital Asset Links](https://developers.google.com/digital-asset-links/v1/getting-started)
- [Custom Tabs](https://developer.chrome.com/docs/android/custom-tabs)
- [android-browser-helper](https://github.com/GoogleChrome/android-browser-helper) (the library `TwaLauncherActivity` extends)
- [WorkManager](https://developer.android.com/topic/libraries/architecture/workmanager)
- [RFC 8628, OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
- [RFC 8252, OAuth 2.0 for Native Apps](https://datatracker.ietf.org/doc/html/rfc8252)
- [Google: modernizing OAuth interactions in native apps](https://developers.googleblog.com/2016/08/modernizing-oauth-interactions-in-native-apps.html)
- [MediaStore and shared media](https://developer.android.com/training/data-storage/shared/media)
- [Android 14 partial photo and video access](https://developer.android.com/about/versions/14/changes/partial-photo-video-access)
- [Foreground service types and the Android 15 dataSync timeout](https://developer.android.com/develop/background-work/services/fgs/timeout)

Internal:

- Docs: [android-media-sync.md](android-media-sync.md), [DEVICE-AUTH.md](../DEVICE-AUTH.md), [personal-access-tokens.md](../personal-access-tokens.md), [SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md), [job-queue.md](job-queue.md), [storage-providers.md](storage-providers.md), [doctor.md](doctor.md), [settings-ui.md](settings-ui.md), [distributed-nodes.md](distributed-nodes.md) (the other first-party client of the upload endpoints).
- Superseded: [android-sync.md](android-sync.md) (the retired v1 app's reference).

## History

- Epic #498 (Android app v2) replaces the legacy standalone Android app with this architecture. The architecture is a port of the evopath native companion design; the feature contract is [android-media-sync.md](android-media-sync.md).
