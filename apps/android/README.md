# MemoriaHub Android app

The MemoriaHub app for Android: a **Trusted Web Activity (TWA)** that renders the MemoriaHub PWA
full-screen in Chrome (no URL bar, brand status bar, splash), plus a small native Kotlin module for
what the web cannot do (Media Sync: reading MediaStore and uploading in the background).

- Contract: [docs/specs/android-media-sync.md](../../docs/specs/android-media-sync.md)
- Architecture: [docs/specs/native-companion-architecture.md](../../docs/specs/native-companion-architecture.md)
- Epic: #498. This scaffold: #508.

Sideload only (no Google Play). The legacy v1 app (`cr.marin.memoriahub`) is a different package;
uninstall it by hand.

## Build

Requirements: JDK 17 or newer and the Android SDK (`platforms;android-36`, `build-tools;36.0.0`,
`platform-tools`). Point Gradle at the SDK with `ANDROID_HOME` (or `sdk.dir` in a git-ignored
`local.properties`). `memoriahub android doctor --fix` installs both (#517).

```bash
cd apps/android
./gradlew testDebugUnitTest assembleDebug     # JVM unit tests + debug APK
./gradlew assembleRelease                     # release APK (signed only with the env below)
```

| Output | Path |
|---|---|
| Debug APK (`memoriahub.marin.cr.debug`) | `app/build/outputs/apk/debug/app-debug.apk` |
| Signed release APK | `app/build/outputs/apk/release/app-release.apk` |
| Unsigned release APK (no signing env) | `app/build/outputs/apk/release/app-release-unsigned.apk` |
| Unit test reports | `app/build/reports/tests/testDebugUnitTest/` |

Check a build's identity with `aapt2 dump badging <apk>` (`$ANDROID_HOME/build-tools/36.0.0/aapt2`):
`package: name='memoriahub.marin.cr'` (release) or `memoriahub.marin.cr.debug` (debug).

## Identity

[`identity.properties`](identity.properties) is the single source of truth. `app/build.gradle.kts`
turns it into `BuildConfig` fields, resources and manifest placeholders; no Kotlin source spells
the product name, package or colours.

| Key | Value | Becomes |
|---|---|---|
| `productName` | `MemoriaHub` | `BuildConfig.PRODUCT_NAME`, `@string/app_name` |
| `applicationId` | `memoriahub.marin.cr` | release `applicationId`; debug adds `.debug` |
| `deepLinkScheme` | `memoriahub` | `BuildConfig.DEEP_LINK_SCHEME`, `${deepLinkScheme}` placeholder |
| `storagePrefix` | `memoriahub` | `BuildConfig.STORAGE_PREFIX`: `memoriahub_config`, `memoriahub_secure`, `memoriahub_sync.db` |
| `themeColor` | `#1976d2` | `BuildConfig.THEME_COLOR`, `@color/brand_primary` |
| `backgroundColor` | `#ffffff` | `BuildConfig.BACKGROUND_COLOR`, `@color/brand_background` |
| `apkStem` | `memoriahub-android` | published file name `memoriahub-android-<versionName>.apk` (CLI, CI) |

- The Kotlin namespace and source package are `memoriahub.marin.cr`
  (`app/src/main/java/memoriahub/marin/cr/`), independent of the build type.
- The build **fails** if `themeColor` / `backgroundColor` differ from `THEME_COLOR` /
  `BACKGROUND_COLOR` in [`apps/web/pwa/manifest.ts`](../web/pwa/manifest.ts), so the TWA's bars and
  splash always match the installed PWA.
- Never change `storagePrefix` or `applicationId` for a shipped app: installed copies would lose
  their server address and pairing, or stop receiving updates.
- `properties` files treat `#` as a comment only at the start of a line; keep comments on their own line.

## Version

[`version.properties`](version.properties) holds `versionName` and `versionCode` for local, CLI and
CI builds. `versionCode` must strictly increase for every published APK and stay in
`1..2100000000` (the build fails otherwise).

## Gradle properties

| Property | Effect |
|---|---|
| `-Papp.versionName=2.0.1` | Overrides `versionName` from `version.properties` |
| `-Papp.versionCode=101` | Overrides `versionCode` (validated 1..2,100,000,000) |
| `-Papp.serverUrl=https://photos.example.com` | Bakes in a server (`BuildConfig.DEFAULT_SERVER_URL`); empty by default, which shows the first-run Setup screen. A URL the user saves in the app wins |

`-Pmemoriahub.versionName` / `-Pmemoriahub.versionCode` / `-Pmemoriahub.serverUrl` (the storage
prefix) are accepted as aliases. The CLI (`memoriahub android build`, #517) passes the `app.` form.

## Signing

Release signing comes **only** from the environment:

| Variable | Meaning |
|---|---|
| `ANDROID_KEYSTORE_FILE` | Path to the keystore (`~/.memoriahub/android/release.jks` from `memoriahub android keystore init`) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias (CLI default `memoriahub`) |
| `ANDROID_KEY_PASSWORD` | Key password |

If any is missing (or the file does not exist), `assembleRelease` still succeeds and produces
`app-release-unsigned.apk`, with a `WARNING:` line in the output. It never fails the build.
The release build runs R8 (`isMinifyEnabled`, `isShrinkResources`; rules in `app/proguard-rules.pro`).

The signing key is the app's identity: losing it means installed copies can never be updated.
Keystores (`*.jks`, `*.keystore`, `*.p12`, `keystore.properties`, `signing/`) are git-ignored.

`scripts/build-meta.sh` prints `product`, `slug`, `application_id`, `version_name` and
`version_code` as `key=value` lines for CI (`>> "$GITHUB_OUTPUT"`).

## What is in the app

| Area | Code |
|---|---|
| Process wiring (lazy singletons, no Hilt/Dagger) | `MobileApplication` (`MobileApplication.from(context)`) |
| TWA launcher | `twa/TwaLauncherActivity`; launcher entry is the stable alias `${applicationId}.TwaLauncherActivity` |
| First-run server setup | `setup/SetupActivity`, `ui/components/ServerUrlEditor` |
| Server address rules (https origins only) and the launch URL | `config/ServerUrls`, `config/ServerConfig` |
| Pairing credential store | `auth/TokenStore` (`SharedPrefsTokenStore`, `EncryptedTokenStore`) |
| HTTP client (envelope unwrap, `ApiError`, no body logging) | `net/ApiClient`, `net/ApiResult` |
| Redacted rolling log | `diagnostics/AppLog` (`Redaction`, `RollingLog`) |
| Media Sync deep links (`memoriahub://media-sync/...`) | `deeplink/MediaSyncLinks` |
| Brand colours and identity | `util/Brand`, `ui/theme/Theme`, `util/AppInfo` |

The TWA opens `<server>/?source=twa&appVersion=<versionName>&appVersionCode=<versionCode>`; the
query is presentation only, never authorization. The URL bar disappears only when the server
serves `/.well-known/assetlinks.json` listing this package and its signing certificate (#503).

Backups are disabled (`allowBackup=false`, and the backup rules exclude all shared preferences and
databases). Cleartext HTTP is allowed only in debug builds, to `10.0.2.2` and `localhost`.

## Icons

Launcher (adaptive, with a monochrome layer) and notification icons are generated from the PWA's
icons and committed:

```bash
node apps/android/scripts/generate-launcher-icons.mjs   # from the repo root; uses sharp
```
