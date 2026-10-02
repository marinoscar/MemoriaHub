# Runbook: Release a new Android APK

> **Audience:** operators · **Spec:** [android-media-sync.md §14](../specs/android-media-sync.md#14-release-model) · **Admin UI:** `/admin/settings/android` (section **Releases**) · **User UI:** `/settings/android-app` · **Permission:** `system_settings:write` (publish, make current, delete); `system_settings:read` (list)

Use this to ship a new version of the Android app to your users, by any route, and to roll one back. To install the app, pair a phone and trust a build, see the [Android app runbook](android-app.md). Each self-hosted MemoriaHub server chooses its own release: nothing is pushed from GitHub to your deployment.

## 1. Quick start

This is the whole flow from a fresh machine to a release your phones can install. It is the supported path (the **CLI**); the other routes are in [section 2](#2-overview-and-the-four-routes).

```bash
git clone https://github.com/marinoscar/MemoriaHub.git && cd MemoriaHub
memoriahub login                          # approve in the browser, as an Admin
memoriahub android doctor --fix --yes     # installs the Android SDK (+ JDK 17 on Debian/Ubuntu)
memoriahub android keystore init          # ONCE; then BACK UP ~/.memoriahub/android/
memoriahub android release --bump patch --notes "What changed"
```

What you should see: `Published <version> (<code>) - now the current release`, then the new release in `/admin/settings/android` and `/settings/android-app`. `/.well-known/assetlinks.json` lists its signer, and paired phones offer the update the next time they open the app.

- **Back up the keystore before the first release.** `~/.memoriahub/android/release.jks` and `signing.json` are the app's identity. Lose them and **every user must uninstall and reinstall** ([section 5](#5-signing-keystore)).
- **A checkout is required.** The build needs `apps/android`. Run the CLI from inside a clone, or pass `--repo <path>` (or set `MEMORIAHUB_REPO_ROOT`). An installed CLI (for example from the curl installer) does not carry the sources; without a checkout, build commands exit with code 6 and say "No MemoriaHub checkout found". `releases`, `releases current`, `publish <apk>` and `keystore …` work anywhere.
- The `memoriahub` command is the CLI from the [curl installer or a local-clone install](../../apps/cli/README.md#install-via-curl). The [CLI README](../../apps/cli/README.md#android-app-build-sign-publish) lists every `android` flag.

## 2. Overview and the four routes

A release moves one APK through five stages. Every route runs the same stages; they differ in who presses the button.

```
 apps/android/version.properties      versionName + versionCode (must rise)
            |
            v
   build + sign (Gradle, your release keystore)
            |      dist/android/memoriahub-android-<versionName>.apk  + .json
            v
   publish: POST /api/admin/android-app/releases   (system_settings:write, max 150 MiB)
            |
            v
   object storage  android-releases/<releaseId>.apk
            |
            v
   current release  (one per deployment; its signing key is trusted automatically)
        |                         |
        v                         v
 users: /settings/android-app     phones: update card and web banner
 (signed 10-minute download link)  (learn on next app open; no push notification)
```

| # | Route | Use it when | Section |
|---|---|---|---|
| 1 | `memoriahub android release` | You have a checkout and the keystore. **Recommended.** | [7.1](#71-one-shot-recommended) |
| 2 | `memoriahub android build`, then `android publish` | You want to build and publish as two steps, or retry a failed publish | [7.2](#72-step-by-step) |
| 3 | The admin page upload (`/admin/settings/android`) | You already have a signed APK and no toolchain on this machine | [8](#8-release-from-the-admin-page) |
| 4 | CI: the **Android** workflow, GitHub prerelease `android-latest` | You want a rolling build on GitHub. **It never publishes to your server** | [9](#9-ci-prerelease) |

The keystore, `version.properties` and the version rules ([section 6](#6-versioning-rules)) apply to every route.

## 3. Prerequisites

- **A JDK 17 or later** for the CLI routes. `memoriahub android doctor --fix` installs `openjdk-17-jdk-headless` (or 21 where 17 is no longer packaged) with `apt` on Debian and Ubuntu, printing each `sudo` command first. On other systems `doctor` prints the instruction.
- **The Android SDK.** `doctor --fix` downloads the command-line tools, accepts the licences and installs `platform-tools`, `platforms;android-36` and `build-tools;36.0.0` into `~/.memoriahub/android-sdk` unless `ANDROID_HOME` or `ANDROID_SDK_ROOT` names one. You should see no red rows in `memoriahub android doctor`.
- **Object storage configured on the server.** The APK lives in object storage, never on local disk of the API. Configure it at Admin, then Settings, then Storage. Without it an upload answers 503 `STORAGE_NOT_CONFIGURED`.
- **An account with `system_settings:write`.** Only the Admin role holds it.
- **The deployment reachable over HTTPS** from your machine and from the phones.
- **Enough memory for Gradle** (a few GB). On a small machine set `MEMORIAHUB_GRADLE_ARGS="--no-daemon --max-workers=1"`; the CLI appends it to every Gradle run.

`doctor` checks, in order: the `apps/android` checkout, the Gradle wrapper, `version.properties`, the JDK, the SDK and its parts, the release keystore and its fingerprint, and (as a hint only) the login. It exits 6 when a required check fails. A missing keystore is a warning for `doctor` (debug builds need none) but `release` requires one. `--json` prints the report on stdout; `--dry-run` prints the `--fix` plan and runs nothing.

## 4. Log in the CLI

Publishing needs a stored login for the server you are publishing to.

1. Run:

   ```bash
   memoriahub login --server https://photos.example.com
   ```

   Without `--server` it prompts, offering the stored URL as the default.
2. The CLI prints a code and the activation address, and opens your browser. Sign in as an **Admin**, check that the code matches and approve.
3. You should see that you are logged in as your account, with the server URL.

What the login is: a **personal access token** stored in `~/.memoriahub/config.json` with restricted permissions, never printed, valid for `DEVICE_PAT_TTL_DAYS` (default 90 days). It carries your account's permissions: releases need `system_settings:write`, so an account without it can log in but cannot publish. Revoke it any time from your account's access tokens. Scripts can skip `login` and set `MEMORIAHUB_URL` and `MEMORIAHUB_TOKEN`; the environment overrides the stored file. `memoriahub login --server <url> --token <pat>` accepts an existing token for headless use.

| State | Meaning | Fix |
|---|---|---|
| Not logged in | No stored token and no environment pair | `memoriahub login --server <url>` |
| Expired | The stored expiry passed, or the server answered 401 | Log in again |
| Other server | The stored login is for a different URL than the one you target | `memoriahub login --server <target url>` |
| Lacks `system_settings:write` | Logged in, but not as an Admin | Log in as an Admin, or ask for the permission |

## 5. Signing keystore

Every update must be signed with the key that signed the first install. Android refuses to update an app with a different key, and the server's trust list names this key.

> **BACK UP THE KEYSTORE NOW.** `~/.memoriahub/android/release.jks` and `signing.json` (the passwords) live outside every checkout. Copy both to a password manager or an encrypted store. **Losing the keystore means a new signing key, a new trust entry, and every user must uninstall and reinstall the app** (their pairing and local sync ledger are lost; the files already on the server are not, and the server de-duplicates by hash). Never commit them: `*.jks`, `*.keystore` and `*.p12` are git-ignored.

| Command | Use it |
|---|---|
| `memoriahub android keystore init [--alias a] [--dname dn]` | **First time only.** Creates `release.jks` (RSA 4096, valid 100 years, default alias `memoriahub`). The password comes from `ANDROID_KEYSTORE_PASSWORD`, a prompt (empty to generate 24 random bytes) or is generated. It **refuses to replace** an existing keystore |
| `memoriahub android keystore import <file> [--alias a]` | You already have a keystore. Passwords come from `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_PASSWORD` or a prompt and are verified with `keytool` before anything is copied |
| `memoriahub android keystore show` | Prints the path, alias and certificate SHA-256 (colon form). Never prints passwords |
| `memoriahub android keystore secrets` | Prints the four GitHub secrets, **including the passwords**, for [section 9](#9-ci-prerelease). Run it on a trusted terminal and clear the screen afterwards |

`MEMORIAHUB_STATE_DIR` moves this directory together with the rest of `~/.memoriahub`.

If phones already run builds signed with an existing key, use `import`. Running `init` afterwards would produce a different fingerprint and every phone would reject the update ([troubleshooting](#12-troubleshooting)).

## 6. Versioning rules

- **One source of truth.** `apps/android/version.properties` holds `versionName` (`x.y.z`) and `versionCode` (a whole number from 1 to 2,100,000,000). Local builds, the CLI and CI all read it. The release also passes them to Gradle as `-Papp.versionName` and `-Papp.versionCode`.
- **`versionCode` must strictly increase for every published APK.** Android refuses to install a lower or equal code over a higher one; phones compare codes, never names.
- **The server enforces it.** An upload whose `(package, versionCode)` already exists is refused with 409 `RELEASE_VERSION_EXISTS`. An upload that would become current but does not exceed the current release's code is refused with 409 `RELEASE_VERSION_NOT_NEWER`, unless forced ([section 7.2](#72-step-by-step)).
- **Bump with the CLI:**

  ```bash
  memoriahub android version                  # show
  memoriahub android version --bump patch     # 2.0.0 (100) -> 2.0.1 (101); also minor, major
  memoriahub android version --set 2.1.0      # sets the name, code + 1
  memoriahub android version --code 200       # explicit code; must exceed the current one
  ```

  Every bump or set also raises `versionCode` by one.
- **Commit the file.** `android release` commits only `apps/android/version.properties`, after the upload succeeded (`chore(android): release <versionName> (<versionCode>)`, never pushed). Other routes leave the bump in your working tree.

## 7. Release from the command line

### 7.1 One shot (recommended)

1. `memoriahub android doctor --fix --yes`, then `memoriahub login --server https://photos.example.com` ([sections 3 and 4](#3-prerequisites)). The release command checks the checkout, the toolchain essentials, the keystore, the login and the version **before it bumps anything**.
2. Run:

   ```bash
   memoriahub android release --bump patch --notes "What changed"
   ```

   `--bump` is `patch`, `minor` or `major`. Without it the current version is released if it is already newer than the server's current release; with nothing changed the command refuses ("not newer, pass `--bump`"). `--server-url <url>` bakes a default server address into the app (the default is the server you are logged in to). `--no-commit` skips the commit.
3. The command bumps `version.properties`, builds and signs the APK, verifies the signer with `apksigner`, uploads it as the **current release** and commits the version file. It writes `dist/android/memoriahub-android-<versionName>.apk` and a sidecar `.json`.

If the build or the upload fails after the bump, nothing is committed and the CLI says how to continue **without bumping again**: fix the cause, then run `memoriahub android build` and `memoriahub android publish`.

Making a release current also **trusts its signing certificate** for the full-screen mode (`/.well-known/assetlinks.json`), while the list has room (at most 10 trusted apps). No separate trust step is needed for releases you publish.

### 7.2 Step by step

```bash
memoriahub android version --bump patch
memoriahub android build [--server-url https://photos.example.com]
memoriahub android publish --notes "What changed"
```

- `build` verifies the signature against your keystore's fingerprint and **refuses an APK signed by another key**. `--debug` builds a debug-signed APK that is not publishable ([section 13](#13-debug-builds-and-trust)).
- `publish [apk]` defaults to the newest APK in `dist/android`. It uploads the file and its sidecar metadata to `POST /api/admin/android-app/releases` (the file streams; it gives up after 15 minutes). `--no-current` uploads without offering it to users. `--force` makes it current even when its `versionCode` is not above the current release's.
- `memoriahub android releases` lists the server's releases (`*` marks the current one); `--json` prints JSON.

### 7.3 The terminal menu

Run `memoriahub` with no arguments in a real terminal and choose **Settings, then Android app (build, publish, releases)**. It shows status rows (checkout, local version, keystore, login and server, the server's current release, and whether yours is newer) and runs the same steps as the commands above: doctor, bump, build, publish, **release**, releases (with rollback) and login. Every confirmation names the version, code and server and defaults to **No**.

## 8. Release from the admin page

Use this when you already have a signed APK.

1. As an Admin open **Admin, then Settings, then Android app** (`/admin/settings/android`), section **Releases**.
2. Under **Upload a release**, choose the `.apk` (at most 150 MiB). You can also choose the sidecar `.json` that `memoriahub android build` wrote next to it; the form then fills in the package, version name, version code and signing fingerprint for you. Otherwise type them in.
3. Add release notes, leave **Make current** ticked unless you want to stage it, and upload. A progress bar shows the transfer.
4. You should see the release at the top of the table. **Make current** and **Delete** are on each row.
5. If the server answers `RELEASE_VERSION_NOT_NEWER`, the page offers a **force** option, with a warning that phones that already installed a higher build will not be offered this one.

The same rules apply: a duplicate `(package, versionCode)` is refused, and making a release current trusts its signer.

## 9. CI prerelease

The **Android** workflow (`.github/workflows/android.yml`) is a convenience, not a release channel for your server.

- **`test`** runs on every pull request and push that touches `apps/android/**`, `apps/web/pwa/manifest.ts` or the workflow: unit tests plus a debug APK artifact.
- **`release`** runs on pushes to `main`: it builds a **signed** release APK with the committed `version.properties`, verifies the signature, uploads the artifact `memoriahub-android`, moves the tag `android-latest` to the built commit and attaches `memoriahub-android.apk` to the GitHub prerelease `android-latest`. The repository's "Latest" release never moves.
- **CI never publishes to a MemoriaHub server.** Doing so would need a long-lived admin token for each deployment in GitHub secrets. Download the APK from the prerelease and upload it through [route 3](#8-release-from-the-admin-page) or `memoriahub android publish <apk>` if you want your server to offer it.
- A phone accepts the APK as an update only when its `versionCode` is higher than the installed one, so bump `version.properties` to ship a new build.

**Set the signing secrets** (repository Settings, then Secrets and variables, then Actions). With the keystore from [section 5](#5-signing-keystore):

```bash
memoriahub android keystore secrets
```

It prints all four values (the output contains secrets: clear it afterwards):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | The keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias (default `memoriahub`) |
| `ANDROID_KEY_PASSWORD` | Key password |

Use the **same** keystore as the APKs your server publishes, or the CI APK is signed by a different identity and will not install over yours. If any secret is missing the `release` job logs a warning ("Android release skipped") and succeeds without building; the debug APK from `test` stays available. The decoded keystore exists only in the runner's temp directory and is deleted even when the build fails.

## 10. Roll back

Roll back when a release is broken and you want phones to stop being offered it.

```bash
memoriahub android releases                    # find the id of the good release
memoriahub android releases current <id> --yes # make it current
```

Or in `/admin/settings/android`, **Make current** on the older row (the page asks to confirm a rollback to a lower version).

What it does and does not do:

- It changes **what the server offers**. New downloads and update checks get the older release. Making it current also adds its signer to the trusted list if it is missing.
- **Phones never auto-downgrade.** Android refuses to install a lower `versionCode` over a higher one. A phone that already installed the bad build keeps it; its owner must uninstall and reinstall (losing the pairing and local ledger; the server's data is untouched and re-sync de-duplicates).
- The better fix is usually to **publish a corrected build with a higher `versionCode`** with `memoriahub android release --bump patch`, so every phone moves forward.
- You cannot delete the current release (409 `RELEASE_IS_CURRENT`): make another current first. Deleting a non-current release also deletes its stored APK.

## 11. Verify a release

Run through this after publishing:

- [ ] `memoriahub android doctor` shows no failing check.
- [ ] `memoriahub android releases` marks the new release current with the right version name and code.
- [ ] `curl -s https://<your-deployment>/.well-known/assetlinks.json` lists `memoriahub.marin.cr` and the signing fingerprint from `memoriahub android keystore show`.
- [ ] `/settings/android-app` shows the new version, its size and SHA-256, and **Download APK** downloads a file whose `sha256sum` matches.
- [ ] On a phone: the self-test checks `app.update` (shows the update, then passes after installing it) and `twa.verification` pass; the app opens full screen.
- [ ] Admin, then Settings, then Doctor: the **Android app** section is green (`android.assetlinks`, `android.releases`, `android.mediaSync`, `android.uploadPath`).

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Exit code 6 "No MemoriaHub checkout found" | The CLI runs outside a clone, or is the installed CLI without the sources | `cd` into the clone, or `--repo <path>` or `MEMORIAHUB_REPO_ROOT` |
| `doctor` fails `jdk` or `sdk` | JDK 17+ or the SDK parts are missing | `memoriahub android doctor --fix --yes` (Debian and Ubuntu); elsewhere install a JDK 17+ and re-run `--fix` for the SDK |
| `release` stops before bumping: no keystore | `release` requires the keystore | `android keystore init` or `import` ([section 5](#5-signing-keystore)) |
| `build` says the APK is signed by another key | The keystore does not match the configured one | Fix `~/.memoriahub/android` or the `ANDROID_KEYSTORE_*` variables; never ship an APK signed by a different key |
| Gradle fails downloading dependencies (429) | Maven Central rate limit | Retry after a minute |
| Gradle runs out of memory | A small machine | `MEMORIAHUB_GRADLE_ARGS="--no-daemon --max-workers=1"` |
| Not logged in, expired, other server, or lacks `system_settings:write` | The login state ([section 4](#4-log-in-the-cli)) | Log in as an Admin on the target server |
| Upload answers 409 `RELEASE_VERSION_EXISTS` | That `versionCode` was already published | `memoriahub android version --bump patch`, rebuild, publish |
| Upload answers 409 `RELEASE_VERSION_NOT_NEWER` | The code is not above the current release's (the response names the current code) | Bump the version. Use `--force` only for a deliberate rollback-style publish |
| Upload answers 400 `RELEASE_NOT_AN_APK` | The file is not an APK (not a ZIP) | Upload the `.apk` that `build` produced |
| Upload answers 400 `RELEASE_INVALID_UPLOAD` | A malformed form: a missing file or field, or a field after the file | Use the CLI or the admin page; the `details.issues` list names the field |
| Upload answers 413 `RELEASE_TOO_LARGE` | The APK is over 150 MiB. A reverse proxy in front of the stack can also refuse earlier | Shrink the APK; with a custom proxy allow bodies of at least 160 MB on `POST /api/admin/android-app/releases` (the shipped nginx files do) |
| Upload answers 503 `STORAGE_NOT_CONFIGURED` | No object storage provider | Admin, then Settings, then Storage |
| Make current answers 409 `RELEASE_CURRENT_CONFLICT` | Another admin changed the current release at the same moment | Reload and try again |
| Delete answers 409 `RELEASE_IS_CURRENT` | The release is the current one | Make another current first |
| The download link answers 410 `DOWNLOAD_LINK_EXPIRED` or 404 `DOWNLOAD_LINK_INVALID` | Links last 10 minutes and are signed | Start the download again from `/settings/android-app` |
| Phones say "App not installed" when updating | The update is signed with a different key, or its `versionCode` is lower | Same key and a higher code. If the key changed, uninstall the old app first |
| The app opens with an address bar | The signer is not in `assetlinks.json` | Trust it ([section 13](#13-debug-builds-and-trust)); check the `curl` output; reopen the app |
| Trusting a build answers 400 `TOO_MANY_TRUSTED_APPS` | The trusted list holds 10 entries | Remove unused entries at `/admin/settings/android` |
| The Doctor warns `android.releases` | Phones are paired but no release is current | Publish one, or make an existing one current |

## 13. Debug builds and trust

A debug build (`memoriahub android build --debug`, or the CI `test` artifact) is a **different app**: its package is `memoriahub.marin.cr.debug` and it is signed with the Android debug key. Consequences:

- It installs next to the release app and has its own pairing and ledger.
- It is **not publishable** and never sees the server's release as an update (its `app.update` check is `skip`).
- It opens **with an address bar** until you trust it by hand: pair it, then at `/admin/settings/android` choose **Trust** on its entry under **Reported apps** ([Android app runbook, section 4](android-app.md#4-make-the-app-open-full-screen)).

The signing key is the trust anchor for the release app. Anyone holding the keystore can ship an update your phones will accept, so keep it as private as a deployment secret.

## See also

- [Android app runbook](android-app.md) (install, trust, pair, operate, diagnose)
- [Android Media Sync spec §14](../specs/android-media-sync.md#14-release-model) (the release model and the CLI contract)
- [`memoriahub android` reference](../../apps/cli/README.md#android-app-build-sign-publish)
- [`apps/android` README](../../apps/android/README.md) (identity, version, signing properties, [continuous integration](../../apps/android/README.md#continuous-integration))
- [Personal access tokens](../personal-access-tokens.md) and [device authorization](../DEVICE-AUTH.md)
