# Runbook: Install, pair and operate the Android app

> **Audience:** operators and the people who use the app · **Spec:** [android-media-sync.md](../specs/android-media-sync.md) · **Admin UI:** `/admin/settings/android` · **User UI:** `/settings/android-app`, `/settings/media-sync` · **Permissions:** `system_settings:write` (trust a build); `media:write` (pair a phone and change its settings)

Use this to install the MemoriaHub Android app, make it open full screen, pair a phone, choose what it backs up and keep it syncing. It also covers what to do when a phone stops syncing. Building, signing and publishing the APK, and rolling a release back, are in the [Android release runbook](android-release.md). The app is optional: nothing on the server changes until a phone pairs. For the design, see the [spec](../specs/android-media-sync.md) and the [architecture](../specs/native-companion-architecture.md).

**What the app is.** The MemoriaHub web app in a Trusted Web Activity (full screen, no URL bar), plus a small native module called **Media sync** that reads the phone's photos and videos and uploads them to a circle in the background. It is installed from your own server, never from Google Play.

**Names in this runbook.**

| Name | Meaning |
|---|---|
| `memoriahub.marin.cr` | The release app's package (application ID) |
| `memoriahub.marin.cr.debug` | A debug build's package: a different app that needs its own trust entry ([section 4](#4-make-the-app-open-full-screen)) |
| `cr.marin.memoriahub` | The **legacy v1 app**, retired. It is a separate package ([section 2](#2-install-the-apk)) |
| `memoriahub://media-sync` | The deep link into the native Media sync screens |
| `~/.memoriahub/android/` | Where the CLI keeps the release keystore (see the release runbook) |

## 1. Before you start

- A **published release**: the server hosts the APK. Publish one with the [Android release runbook](android-release.md) (CLI first). Until then `/settings/android-app` says "No Android release has been published yet."
- An Android phone with **Android 8 or later** (minSdk 26) and Chrome (the TWA needs it).
- The deployment reachable over **HTTPS** from the phone. The app refuses an `http://` address or an address with a path.
- A user account with the `media:write` permission and a circle where it is a collaborator or admin (its personal circle qualifies), to pair and choose the target. An Admin account to trust a non-release build.
- Object storage configured on the server (Admin, then Settings, then Storage). Phone uploads go through the same storage pipeline as the CLI.

## 2. Install the APK

1. On the phone, sign in to the web app and open **Settings**, then the **Android app** panel, then **Download** (or go straight to `/settings/android-app`). The page shows the current release (version, build number, size, notes) and its SHA-256, and an install checklist.
2. Tap **Download APK**. Android asks to allow installs from your browser: allow it for this install.
3. Open the downloaded file and tap **Install** (or **Update**).
4. **Uninstall the legacy v1 app if it is installed.** The old app's package is `cr.marin.memoriahub`; the new app's is `memoriahub.marin.cr`. They are two separate apps, so v1 **stays installed and keeps uploading on its own** until you remove it. Android Settings, then Apps, then the old MemoriaHub, then Uninstall. Its uploads are not lost: the server de-duplicates by file hash, so the new app skips what v1 already sent.
5. To update later, install the newer APK over the old one from the same page. Pairing and settings survive because the signing key is the same. Inside the app, a banner and the Hub's **Update** card offer the update when the server holds a newer release.

> **Checking the file.** The page shows the SHA-256 of the APK. Compare it with `sha256sum` on a computer if you downloaded elsewhere.

## 3. First run: the server address

1. Open the app. With no baked-in server it shows **Welcome to MemoriaHub**: enter your deployment's address, for example `https://photos.example.com`, and tap **Save and open**.
2. Only an `https` origin is accepted (no path, query or credentials), because the Trusted Web Activity and Digital Asset Links require HTTPS. A server baked into the build (`-Papp.serverUrl`, see the release runbook) skips this screen; an address the user saves always wins.
3. The app opens the web app. Until the build is trusted it shows a browser address bar ([section 4](#4-make-the-app-open-full-screen)).

The install page at `/settings/android-app` shows this server's address with a copy button so you can paste it.

## 4. Make the app open full screen

Full screen needs the server to publish a **Digital Asset Links** file that names the app's package and signing key.

- **Releases trust themselves.** Making a release current ([release runbook](android-release.md)) adds its signing certificate to the trusted list automatically, while the list has room (at most 10 entries). For a normal install from `/settings/android-app` there is nothing to do.
- **Debug builds and other builds need a manual trust.** `memoriahub.marin.cr.debug` is a different package, and a build signed with another key is a different identity.

To trust a build by hand:

1. Open the app once and pair it ([section 5](#5-pair-the-phone)). The app reports its own package and signing fingerprint when it registers.
2. As an Admin open **Admin, then Settings, then Android app** (`/admin/settings/android`). Under **Reported apps** you should see the package, its SHA-256 fingerprint and a device count.
3. Choose **Trust**, then save. The live Digital Asset Links preview now lists the app.
4. Check the public file:

   ```bash
   curl -s https://<your-deployment>/.well-known/assetlinks.json
   ```

   You should see a JSON array whose `target.package_name` includes `memoriahub.marin.cr` and your signing fingerprint.
5. Close and reopen the app. Chrome may cache an earlier answer for a few minutes; if the address bar stays, wait, or clear the app's storage, then reopen.

`/.well-known/assetlinks.json` stays reachable during a maintenance window on purpose: Chrome caches a failed verification, so a 503 would leave installed apps with a URL bar long after the window.

## 5. Pair the phone

Pairing links this phone to your account with a long-lived token that only works for your own data. It uses the same device-flow approval as the CLI ([DEVICE-AUTH.md](../DEVICE-AUTH.md)).

1. **Long-press the app icon** on the home screen and choose **Media sync**. (Inside the app, the web app's Settings panel also has **Open Media sync on this phone**; the deep link is `memoriahub://media-sync`.)
2. Tap **Connect**, then **Pair with MemoriaHub**. The app shows a code and opens the sign-in page in a browser tab.
3. Sign in if asked, check that the code matches and approve. The app comes back on its own (`memoriahub://media-sync/paired`).
4. You should see **Paired. Token expires <date>.** and, under **Settings, then Media sync** on the web, a card for the phone with status active. The token lasts `DEVICE_PAT_TTL_DAYS` (default 90 days).
5. On the Connect screen, **allow access to photos and videos**, **allow photo location** and **allow notifications** (Android 13 and later):
   - **Full access** (all photos and videos) is what you want. Choosing "Select photos and videos" on Android 14 and later gives *partial* access: only the items you picked sync, and the app says so. Use **Allow access to all photos** to widen it.
   - **Photo location** (`ACCESS_MEDIA_LOCATION`): without it Android strips GPS from the bytes the app uploads. Allow it if you want locations in the library.
   - **Notifications** show upload progress and tell you when something needs attention.

If registration fails after approval, the Connect screen says "Signed in, but this phone is not registered yet" and offers **Retry registration**: the token is already stored, so you do not approve again.

## 6. Choose what to back up

Defaults after pairing: no folders selected, photos and videos both included, **Wi-Fi only**, any charge state, **upload existing: all**, and your personal circle as the target. Nothing uploads until you select at least one folder. The settings live in one place on the server and are shown in both the app and the web, so either can edit them.

| Setting | What it does |
|---|---|
| **Folders** | The phone's photo and video folders (camera, screenshots, WhatsApp, and so on). Only selected folders sync. Pick them on the phone (Hub, then **Folders**, a live list with counts) or on the web (Settings, then Media sync, the phone's card). A folder appears on the web only after the phone has reported its folders, so open the app once first. |
| **Include photos / Include videos** | Narrow the selected folders by type. |
| **Wi-Fi only** or **Wi-Fi and mobile data** | The network policy. Under Wi-Fi only, an upload that is under way when the phone leaves Wi-Fi stops between parts and resumes later. Large videos can use a lot of mobile data. |
| **Only while charging** | Run only when the phone is charging. |
| **Upload existing** | **All** photos and videos already in the selected folders, or **only new ones taken from now on** (from the time of pairing). Switching to "only new" excludes the rest. |
| **Target circle** | Where the media lands. Choose a circle where you are a collaborator or admin. Change it on the web (Settings, then Media sync); the phone shows it read-only. |

### 6.1 How "applies at next check-in" works

The server keeps the **desired settings** and the phone **pulls** them. The phone checks in at the start and end of every sync run, so a change made on the web is applied the next time the phone syncs, which can be hours. The card shows **"Changes pending, will apply next time the phone checks in"** until then. To apply sooner:

- Open the app. Opening it starts a run, and so a check-in (at most once every 15 minutes).
- Tap **Sync now** on the phone.
- Inside the app, the web card has **Apply now on this phone** (it opens `memoriahub://media-sync?action=apply`).

The buttons on the web card (**Stop**, **Start**, **Retry failed**, **Sync now**) work the same way: the server records the command and the phone carries it out at its next check-in.

A change made on the phone is sent to the server immediately; if the phone is offline, the change waits in a small outbox and is sent first at the next check-in.

### 6.2 What counts as synced

The phone keeps a per-file ledger and is the source of truth. The Hub and the web show **Synced** (uploaded or already on the server), **Missing** (everything eligible that is not synced: pending, uploading, failed and blocked) and the failed and blocked counts. Deleting a photo on the phone **never** deletes it on the server.

## 7. Background behaviour

- **New photos are picked up in batches, not instantly.** The app asks Android to wake it when the media store changes, then waits about 15 seconds (up to 2 minutes) so a burst of photos becomes one run.
- **A catch-up runs every 6 hours** regardless, to cover anything the trigger missed. Opening the app also starts a run (at most every 15 minutes).
- **Constraints.** Runs wait for the right network (Wi-Fi for Wi-Fi only), for charging when required, and for the phone not to be low on storage.
- **A notification shows progress** ("Uploading 3 of 120 · IMG_1234.jpg · 45%") with a **Pause** button whenever more than one file or more than 50 MB is pending. If you hide notifications on Android 13 and later, the work still runs.
- **Stop and start.** **Stop syncing** (phone) or **Stop** (web) pauses everything, including the triggers. **Start syncing** resumes and runs at once.
- **Android 15 limit.** Android caps this kind of foreground work at about **6 hours per 24 hours**. When the cap is reached the run stops cleanly, is recorded as partial with the code `FGS_TIMEOUT`, and the next periodic or trigger run **resumes where it stopped** (finished parts are never re-sent). A very large first backup therefore takes several days of runs, which is expected.
- **Foreground start can be refused.** On Android 12 and later the system may refuse to show the progress notification from the background. The sync carries on as ordinary background work.

### 7.1 Exempt the app from battery optimization

Battery managers delay or block background work, and the new-photo trigger is the first thing they break. The **Battery optimization** diagnostic warns when the app is not exempt. Open it from the app (**Diagnostics**, then **Battery optimization**, then the action), or:

- **Stock Android and Pixel:** Settings, then Apps, then MemoriaHub, then Battery, then **Unrestricted**.
- **Samsung (One UI):** Settings, then Battery, then Background usage limits: remove MemoriaHub from **Sleeping apps** and **Deep sleeping apps**, and turn off "Put unused apps to sleep" for it. Also set the app's Battery to **Unrestricted**.
- **Xiaomi, Redmi, POCO (MIUI, HyperOS):** Settings, then Apps, then Manage apps, then MemoriaHub: turn on **Autostart**, set Battery saver to **No restrictions**, and lock the app in the recents screen so it is not cleared.
- **Huawei and Honor (EMUI, MagicOS):** Settings, then Battery, then App launch: switch MemoriaHub to **Manage manually** and allow **Auto-launch**, **Secondary launch** and **Run in background**.
- **OnePlus, Oppo, Realme (OxygenOS, ColorOS):** Settings, then Battery, then Battery optimization: set MemoriaHub to **Don't optimize**; allow **Auto-launch** and **Background activity** in the app's info page.

Other makers have similar switches; the community list at dontkillmyapp.com tracks them. Even exempted, expect the new-photo trigger to be late sometimes; the 6-hour catch-up and **Sync now** are the backstop.

## 8. Upload problems

| Symptom | Cause | Fix |
|---|---|---|
| A large video never finishes on the **local** storage provider | The local provider has no presigned URLs, so each part goes through the API's own part route. The reverse proxy must allow a part (64 MB) through, and the API must be reachable for the whole transfer | Use the shipped nginx files (`infra/nginx/nginx.conf` and `nginx.prod.conf` carry the part-upload location). With a custom proxy, allow `PUT /api/storage/objects/<id>/upload/parts/<n>` bodies of at least the part size and disable request buffering. The Doctor check `android.uploadPath` confirms the provider can take phone parts |
| The run ends with `UPLOAD_PARTS_MISSING` or `UPLOAD_SESSION_INVALID` | The server lost a part or forgot the upload session (a restart, a purge, a provider change) | Nothing to do: the app re-sends the missing parts, or starts that file over, on its own. If it repeats, check storage health and the **Upload backlog** diagnostic |
| `TARGET_CIRCLE_FORBIDDEN` (check `upload.target`, run error code, files blocked) | The target circle was changed to one where the account is no longer a collaborator, or the account lost `media:write` | On the web, Settings, then Media sync, choose a circle where you are a collaborator or admin. Then **Retry failed** |
| Files show **Blocked** | A file failed five times, or the server refused it permanently (for example a 4xx other than a retryable one). Blocked files wait for a manual retry | Read the error on the row (Hub, then **Files**, then **Blocked**), fix the cause, then **Retry** that row or **Retry blocked**. The web's **Retry failed** also re-queues blocked files |
| Files show **Failed** | A retryable error (network, server 5xx). The app retries by itself: after 30 seconds, then 2 minutes, 10 minutes and 1 hour; the fifth failure blocks the file | Wait, or tap **Retry all failed** to try again immediately |
| Photos upload without location | `ACCESS_MEDIA_LOCATION` is not granted, so Android removed the GPS before upload | Grant it ([section 5](#5-pair-the-phone)). Files already uploaded keep no location; re-upload is not automatic |
| Nothing uploads from a folder | The folder is not selected, the type is excluded, or "upload existing: only new" excludes older items | Check Folders and Upload existing on the phone or the web |
| The same photo appears once | By design: the server de-duplicates by file hash within a circle | Nothing to fix |

## 9. Diagnostics

Start with the **Diagnostics** screen on the phone (long-press the icon, then **Diagnostics**, or Hub, then **Diagnostics**).

1. Tap **Run self-test**. Each failing or warning check names its remedy and often has a button that fixes it.
2. Tap **Upload report**. The app shows "Report uploaded (id …)" and a button to open Media sync settings.
3. On the web open **Settings, then Media sync**, the phone's card, then **Diagnostics**. The latest reports list each check (failures first) and the raw JSON. Reports belong to your account.
4. **Share report** and **Copy to clipboard** are there for bug reports. Tokens and URLs with a query string are masked in the log and the report.

The phone also uploads a report on its own after a failed or partial run, at most once every 6 hours, while it is paired and the server answers. So a recent report is usually waiting when something breaks.

## 10. Troubleshooting by check id

Each row is one self-test check on the Diagnostics screen. **Warn** and **fail** are what you act on; `skip` means the check does not apply.

| Check id | Symptom | Cause | Fix |
|---|---|---|---|
| `app.version` | Information only | Shows the version and build | None |
| `app.update` | Warns "an update is available". `skip`: no release, the release is for another package (a debug build), the phone is not paired, or the check failed | The server's current release has a higher `versionCode` than the installed app | Tap **Get the update** (Hub update card or the check's action) or install from `/settings/android-app` ([section 2](#2-install-the-apk)) |
| `server.configured` | Fails | No server address stored | Enter it ([section 3](#3-first-run-the-server-address)) |
| `server.reachable` | Fails | No network, wrong address, or the deployment is down. `GET /api/health/live` must answer within 5 seconds | Open the address in the phone's browser; fix the address or the deployment |
| `pairing.token` | Fails (no token) or warns (expires in under 14 days) | Not paired, or the token is close to expiry | **Re-pair** ([section 12](#12-unpair-re-pair-and-token-expiry)) |
| `auth.valid` | Fails | The server answered 401 (token expired or revoked) or 404/409 (the device was removed or revoked) | **Re-pair** |
| `api.connection` | Fails | The last check-in did not succeed in the past 24 hours | Fix `server.reachable` or `auth.valid` first, then **Sync now** |
| `media.permission` | Passes (full), warns (partial: "only selected photos sync") or fails (denied) | Access to photos and videos was narrowed or refused | **Grant media access** from the check, or Android Settings, then Apps, then MemoriaHub, then Permissions. Pick "Allow all" |
| `media.location` | Warns | `ACCESS_MEDIA_LOCATION` not granted, so GPS is stripped from uploads | **Grant media access**; allow photo location |
| `media.folders` | Fails (none selected) or warns (a selected folder no longer exists) | No folders chosen, or a folder was deleted or renamed | **Choose folders** ([section 6](#6-choose-what-to-back-up)) |
| `media.trigger` | Fails | The new-photo trigger is not scheduled (the app was force-stopped, or its work was cancelled). Not reported while paused | **Sync now** re-arms it; open the app |
| `work.periodic` | Fails or warns | The 6-hour background run is not scheduled | **Sync now** re-schedules it; if it keeps disappearing see `battery.optimization` |
| `sync.paused` | Warns | Sync is paused | **Resume** |
| `network.policy` | Warns | "Wi-Fi only" is set, the phone is on mobile data and files are waiting | Connect to Wi-Fi, or change the policy to Wi-Fi and mobile data ([section 6](#6-choose-what-to-back-up)) |
| `battery.optimization` | Warns | The app is not exempt, so Android delays background work | Exempt it ([section 7.1](#71-exempt-the-app-from-battery-optimization)) |
| `notifications.permission` | Warns (Android 13 and later) | Notifications are off | Allow them, or you will miss progress and "re-pair" messages. Syncing still works |
| `sync.last` | Warns (last good run is older than 24 hours with files pending) or fails (three failed runs in a row) | The work is blocked (battery, no network), or runs keep failing | Fix `battery.optimization`, then **Sync now**; read the run's error code under the phone's card on the web |
| `upload.backlog` | Warns (failed files) or fails (blocked files) | Files failed or were refused; the counts are in the detail | **Retry failed** ([section 8](#8-upload-problems)) |
| `upload.stalled` | Warns | A file has been uploading for over an hour with no progress | **Retry failed**; if it repeats on a big file, see the local-provider row in [section 8](#8-upload-problems) |
| `upload.target` | Fails | The last upload got `TARGET_CIRCLE_FORBIDDEN` | Choose a different target circle on the web ([section 8](#8-upload-problems)) |
| `storage.space` | Warns under 500 MB free | Hashing and temporary files need room | Free some space on the phone |
| `twa.verification` | Warns (never fails) | `/.well-known/assetlinks.json` does not list this package and signing key, could not be fetched, or Chrome cached an old answer. The app still works with a URL bar | Trust the build ([section 4](#4-make-the-app-open-full-screen)); check the `curl` output; reopen the app. The Doctor check `android.assetlinks` shows the same on the server |

Server-side symptoms:

| Symptom | Cause | Fix |
|---|---|---|
| Registering answers 400 `PAT_REQUIRED` | The phone used a web session instead of its pairing token | Re-pair so the app receives a `pat_` token (it refuses anything else) |
| A check-in answers 409 `DEVICE_REVOKED` | The device was unpaired on the web, or its token was re-issued | Re-pair; the phone's local ledger is kept, so nothing is re-uploaded |
| `/settings/media-sync` shows no folders to pick | The phone has not reported its folders yet | Open the app on the phone once so it can check in |
| A change on the web does not reach the phone | It applies at the next check-in | [Section 6.1](#61-how-applies-at-next-check-in-works) |
| The app opens with an address bar | The build is not trusted yet | [Section 4](#4-make-the-app-open-full-screen) |
| Pairing fails and syncs answer 503 | A maintenance window is open: the device-flow routes and the upload routes are blocked. `assetlinks.json` stays reachable | Close the window ([maintenance runbook](maintenance-mode.md)), then pair or sync again |
| Upload of the APK answers 409 `RELEASE_VERSION_EXISTS` / `RELEASE_VERSION_NOT_NEWER`, or 503 `STORAGE_NOT_CONFIGURED` | Publishing problems | [Release runbook, troubleshooting](android-release.md#12-troubleshooting) |

## 11. The Doctor `android` section

Admin, then Settings, then **Doctor** (`/admin/settings/doctor`) has an **Android app** section with four checks. It needs no phone to be open; it reads the server's view. See the [Doctor spec](../specs/doctor.md).

| Check | Status | Meaning and fix |
|---|---|---|
| `android.assetlinks` | Skipped | No active phone has reported its signing key yet |
| | Warning | A phone reported a package and signing key that is not in the trusted list (up to 3 are named). Trust it at Admin, then Settings, then Android app ([section 4](#4-make-the-app-open-full-screen)) |
| | OK | Every reported package and key is trusted |
| `android.releases` | Skipped | No active phone |
| | Warning | Phones are paired but no release is current. Publish one ([release runbook](android-release.md)) |
| | OK | A release is current; the message says how many phones are behind it |
| `android.mediaSync` | Skipped | No active phone |
| | Warning | A phone has not been seen for over 48 hours, has blocked files, lacks full media access, or its token was revoked or expired (the phones and counts are named) |
| | OK | Otherwise |
| `android.uploadPath` | OK | The active storage provider takes phone uploads (presigned parts for S3 and R2, or the API part route for the local provider) |
| | Error | No storage provider is configured. Configure it at Admin, then Settings, then Storage |

## 12. Unpair, re-pair and token expiry

- **Unpair from the web.** Settings, then Media sync, the phone's card, then **Unpair**. The token is revoked at once and the phone stops syncing. Already uploaded media stays.
- **Unpair from the phone.** Connect, then **Unpair**. If the server cannot be reached, the app offers **Remove from this phone**, which forgets the pairing locally; remove the device on the web later.
- **Re-pair.** A token lasts `DEVICE_PAT_TTL_DAYS` (default 90 days). The `pairing.token` check warns 14 days before the end. At expiry, or after a revoke, the phone posts a **"Pairing expired, re-pair"** notification and syncing stops. Open Media sync, then **Connect**, then **Re-pair**. The phone keeps its identity across re-pairing, so the server reuses the same device row and the history stays. The old token is revoked.
- **Reinstalled with a different key.** A build signed with another key is a different identity: trust the new fingerprint and remove the old entry ([section 4](#4-make-the-app-open-full-screen)).

## 13. Privacy

What leaves the phone: the **file bytes**, each file's **path** (as the source path on the item), its **capture date**, the **device name**, and, when photo location access is granted, the **GPS embedded in the file**. Nothing is read or uploaded from folders that are not selected. The pairing token is stored encrypted on the phone and never written to the log. Android backups of the app are disabled.

## 14. Summary checklist

- [ ] A release published and current ([release runbook](android-release.md), including the keystore backup)
- [ ] The legacy v1 app (`cr.marin.memoriahub`) uninstalled
- [ ] APK installed from `/settings/android-app`; server address entered
- [ ] Phone paired (long-press, Media sync, Connect)
- [ ] Build trusted (automatic for releases); `assetlinks.json` lists it
- [ ] Photo and video access granted (full), plus photo location and notifications
- [ ] Folders and network policy chosen; target circle correct
- [ ] Battery optimization exempted
- [ ] **Sync now** shows a run with status ok; the web card counts move
- [ ] The self-test reports no failing check

## See also

- [Android release runbook](android-release.md) (keystore, versioning, publishing, rollback)
- [Android Media Sync spec](../specs/android-media-sync.md) and [native companion architecture](../specs/native-companion-architecture.md)
- [`memoriahub android` reference](../../apps/cli/README.md#android-app-build-sign-publish)
- [`apps/android` README](../../apps/android/README.md) (build, identity, signing, CI)
- [Device authorization](../DEVICE-AUTH.md) and [personal access tokens](../personal-access-tokens.md)
- [Doctor spec](../specs/doctor.md) (the `android` section)
- [Maintenance mode runbook](maintenance-mode.md)
