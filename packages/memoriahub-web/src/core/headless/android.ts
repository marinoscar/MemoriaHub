import { useMemoriahubHost } from './host.js';

/**
 * The release a server offers to the Android app's users (the public view of an APK release).
 *
 * @stability experimental
 */
export interface MemoriahubPublicRelease {
  /** The release id. */
  id: string;
  /** The Android package name. */
  packageName: string;
  /** The human version, for example `1.4.0`. */
  versionName: string;
  /** The monotonically increasing build number. */
  versionCode: number;
  /** The SHA-256 of the APK, lowercase hex. */
  fileSha256: string;
  /** The APK size in bytes, as a decimal string (a `BigInt` column on the server). */
  sizeBytes: string;
  /** The release notes, or `null`. */
  notes: string | null;
  /** When the release was uploaded (ISO 8601). */
  createdAt: string;
}

/**
 * A short-lived same-origin link the APK is downloaded from.
 *
 * @stability experimental
 */
export interface MemoriahubDownloadLink {
  /** The link, `/api/android-app/download/<token>`. */
  url: string;
  /** When the link stops working (ISO 8601). */
  expiresAt: string;
}

/**
 * The build the Trusted Web Activity launch URL reported.
 *
 * @stability experimental
 */
export interface MemoriahubInstalledAppVersion {
  /** The installed version name, or `null` when the launch did not carry it. */
  versionName: string | null;
  /** The installed build number. */
  versionCode: number;
}

/**
 * A path under `memoriahub://media-sync` the phone opens a Media Sync screen at.
 *
 * @stability experimental
 */
export type MemoriahubMediaSyncDeepLinkPath = 'connect' | 'paired' | 'folders' | 'network' | 'files' | 'diagnostics';

/**
 * The `action` of a Media Sync deep link.
 *
 * @stability experimental
 */
export type MemoriahubMediaSyncDeepLinkAction = 'apply' | 'sync' | 'retry' | 'pause' | 'resume';

/**
 * What {@link MemoriahubAndroidPort.useAndroidRelease} returns.
 *
 * @stability experimental
 */
export interface MemoriahubAndroidReleaseState {
  /** The current release, `null` when none is published (or while loading). */
  release: MemoriahubPublicRelease | null;
  /** True while the request is in flight. */
  isLoading: boolean;
  /** The failure message, `null` when none; a `NO_RELEASE` answer is not an error. */
  error: string | null;
}

/**
 * What {@link MemoriahubAndroidPort.useAndroidDownloadLink} returns.
 *
 * @stability experimental
 */
export interface MemoriahubAndroidDownloadLinkClient {
  /** Mints a short-lived download link for a release (`POST /android-app/releases/:id/download-link`). */
  downloadLink(releaseId: string): Promise<MemoriahubDownloadLink>;
}

/**
 * The Android companion's identity and platform helpers the Media Sync and download pages ask their host for.
 *
 * @remarks
 * Presentation only, never authorization: the web never calls native code (no JavaScript bridge), and
 * a launch from the Trusted Web Activity only hides install prompts. The identity constants (`memoriahub.marin.cr`,
 * the `memoriahub` scheme) are the host's, mirrored from `apps/android/identity.properties`.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface MemoriahubAndroidPort {
  /** The product name, as the pages name the app. */
  appName: string;
  /** The retired v1 app's package name, which users uninstall by hand. */
  legacyPackageName: string;
  /** A `memoriahub://media-sync[/<path>][?action=<action>]` deep link. */
  mediaSyncDeepLink(path?: MemoriahubMediaSyncDeepLinkPath, action?: MemoriahubMediaSyncDeepLinkAction): string;
  /** Whether this tab was opened by the Android app's Trusted Web Activity. */
  isRunningInTwa(): boolean;
  /** The installed build the launch URL named, or `null`. */
  getInstalledAppVersion(): MemoriahubInstalledAppVersion | null;
  /** A React hook over the release this server offers (the same function for the life of the host). */
  useAndroidRelease(): MemoriahubAndroidReleaseState;
  /** A React hook over the download-link call (the same function for the life of the host). */
  useAndroidDownloadLink(): MemoriahubAndroidDownloadLinkClient;
}

/**
 * Thrown when an Android page renders in a host that supplies no Android port.
 *
 * @stability experimental
 */
export class MemoriahubAndroidPortMissingError extends Error {
  /** Names the missing port so a stack trace is self-explanatory. */
  constructor() {
    super(
      'The MemoriahubWebHost has no `android` port: the Media Sync and Android download pages of @marinoscar/memoriahub-web ' +
        'need the app identity, the TWA helpers and the release hooks from their host (the web edition binds them in apps/web/src/platform-memoriahub/android.ts).',
    );
    this.name = 'MemoriahubAndroidPortMissingError';
  }
}

/**
 * The host's Android port, as a React hook.
 *
 * @returns the port
 * @throws {@link MemoriahubAndroidPortMissingError} when the host has none
 * @stability experimental
 */
export function useMemoriahubAndroid(): MemoriahubAndroidPort {
  const { android } = useMemoriahubHost();
  if (!android) throw new MemoriahubAndroidPortMissingError();
  return android;
}
