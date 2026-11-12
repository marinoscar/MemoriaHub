# media-sync

The Android companion on the web: the Media Sync page (the phones paired to this server) and the Android app download page, with the clients and hooks behind them.

## Purpose and scope

`media-sync/headless` carries the Media Sync device clients over the host's API client (`listDevices`, `getDevice`, `updateDeviceConfig`, `sendDeviceCommand`, `listDeviceRuns`, `listDeviceDiagnostics`, `getDeviceDiagnostic`, `unpairDevice`, the error helpers and `deviceStatusLines`), the user-side release clients (`getLatestRelease`, `createDownloadLink`, `isNoReleaseError`, `formatMegabytes`) and the hooks that load them (`useMediaSyncDevices`, `useDeviceRuns`, `useDeviceDiagnostics`, `useLatestRelease`). The wire shapes are the contract's `media-sync` slice. `media-sync/ui` carries `MediaSyncPage`, `AndroidAppDownloadPage` and the pieces of a device card: `DeviceCard`, `DeviceControls`, `MediaSyncConfigEditor`, `FailedFiles`, `SyncHistory`, `SyncCountTiles`, `DiagnosticsSection`, `DiagnosticReportViewer`, `RunStatusChip`, `UnpairDialog`, `GetAndroidApp` and `DownloadApkButton`.

The web never calls native code (no JavaScript bridge): the slice only links to the phone (`memoriahub://media-sync` deep links) and displays what the phone reported through the server. Awareness of the Trusted Web Activity is presentation only, never authorization. The application identity, the TWA helpers and the release and download-link hooks are the host's Android port (`useMemoriahubAndroid` of `core`); the web app binds the platform android-app slice there and keeps the identity drift test (`apps/web/src/__tests__/platform/androidIdentity.test.ts`) that compares it with `apps/android/identity.properties`.

## Entry point

`@marinoscar/memoriahub-web/media-sync/headless` and `@marinoscar/memoriahub-web/media-sync/ui`. The slice imports `core` through its entries.

## Peer dependencies

`react`, `react-dom` and `@marinoscar/memoriahub-contract` for every file (the Media Sync wire schemas); the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, permissions, owner scope and Android port.

## Extension-point catalog

None: the slice registers no slot of its own; the Android port it reads is `core`'s `MemoriahubAndroidPort`.
