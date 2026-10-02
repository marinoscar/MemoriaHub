/**
 * android/release-status.ts — where the local version stands against the server (issue #517).
 *
 * One answer to "can I release, and would it be newer?", used by the TUI's
 * Android screen and `android doctor`'s login hint:
 *
 *   local     apps/android/version.properties
 *   keystore  ~/.memoriahub/android/signing.json (its cached certificate SHA-256)
 *   login     the stored login, checked with `GET /api/auth/me` for system_settings:write
 *   server    `GET /api/android-app/releases/latest` (404 NO_RELEASE = nothing published)
 *
 * THE TOKEN NEVER LEAVES THIS MODULE'S LOCALS: `ReleaseStatus` has no field
 * that could hold one, so a screen that keeps it in React state cannot render it.
 */

import { ApiError } from '../api.js';
import { errorMessage } from './errors.js';
import { readIdentity } from './identity.js';
import { readSigningConfig } from './keystore.js';
import { versionPropertiesPath, type AndroidPathsContext } from './paths.js';
import {
  PUBLISH_PERMISSION,
  apiClientFor,
  latestRelease,
  storedCredentials,
  type AndroidRelease,
  type CurrentUser,
  type JsonApi,
  type ServerCredentials,
} from './publish.js';
import { readVersion, type AppVersion } from './version.js';

export type LoginState = 'logged_in' | 'logged_out' | 'expired';

export interface ReleaseLoginStatus {
  state: LoginState;
  serverUrl?: string | undefined;
  /** True only when `/auth/me` confirmed system_settings:write. */
  canPublish: boolean;
  email?: string | undefined;
  /** Why `/auth/me` could not answer (network, 5xx). */
  error?: string | undefined;
}

export interface ReleaseServerStatus {
  /** `null` when nothing is published, or when it could not be read. */
  current: AndroidRelease | null;
  /** The server answered the latest-release request (404 NO_RELEASE included). */
  reachable: boolean;
  error?: string | undefined;
}

export interface ReleaseStatus {
  repoRoot: string | undefined;
  local: AppVersion | null;
  packageName: string;
  keystore: { configured: boolean; sha256?: string | undefined; error?: string | undefined };
  login: ReleaseLoginStatus;
  server: ReleaseServerStatus;
  /** Local versionCode is above the server's current one (or the server has none). */
  newerLocally: boolean;
}

export interface ReleaseStatusDeps {
  paths?: AndroidPathsContext | undefined;
  credentials?: (() => ServerCredentials | undefined) | undefined;
  client?: ((credentials: ServerCredentials) => JsonApi) | undefined;
}

/**
 * `local` is publishable over `current`: strictly higher code, or nothing
 * published for this package. A current release of ANOTHER package (e.g. a
 * hand-uploaded debug build) does not block, matching the server's rule.
 */
export function isNewerLocally(local: AppVersion | null, server: ReleaseServerStatus, packageName: string): boolean {
  if (local === null || !server.reachable) return false;
  if (server.current === null || server.current.packageName !== packageName) return true;
  return local.versionCode > server.current.versionCode;
}

function readLocal(repoRoot: string | undefined): AppVersion | null {
  if (repoRoot === undefined) return null;
  try {
    const version = readVersion(versionPropertiesPath(repoRoot));
    return version.exists ? { versionName: version.versionName, versionCode: version.versionCode } : null;
  } catch {
    return null;
  }
}

function readKeystore(paths: AndroidPathsContext | undefined): ReleaseStatus['keystore'] {
  try {
    const signing = readSigningConfig(paths);
    if (signing === undefined) return { configured: false };
    return { configured: true, ...(signing.certSha256 === undefined ? {} : { sha256: signing.certSha256 }) };
  } catch (error) {
    return { configured: false, error: errorMessage(error) };
  }
}

export async function getReleaseStatus(repoRoot: string | undefined, deps: ReleaseStatusDeps = {}): Promise<ReleaseStatus> {
  const local = readLocal(repoRoot);
  const packageName = readIdentity(repoRoot).applicationId;
  const keystore = readKeystore(deps.paths);
  const finish = (login: ReleaseLoginStatus, server: ReleaseServerStatus): ReleaseStatus => ({
    repoRoot,
    local,
    packageName,
    keystore,
    login,
    server,
    newerLocally: isNewerLocally(local, server, packageName),
  });
  const notReached = (error: string): ReleaseServerStatus => ({ current: null, reachable: false, error });

  let credentials: ServerCredentials | undefined;
  try {
    credentials = (deps.credentials ?? storedCredentials)();
  } catch (error) {
    return finish({ state: 'logged_out', canPublish: false, error: errorMessage(error) }, notReached('Not logged in.'));
  }
  if (credentials === undefined) {
    return finish({ state: 'logged_out', canPublish: false }, notReached('Not logged in.'));
  }

  const client = deps.client !== undefined ? deps.client(credentials) : apiClientFor(credentials, { quick: true });
  const base = { serverUrl: credentials.serverUrl };

  let user: CurrentUser;
  try {
    user = await client.get<CurrentUser>('/api/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return finish(
        { state: 'expired', canPublish: false, ...base, error: 'The server rejected the stored token (expired or revoked).' },
        notReached('The server rejected the stored token.'),
      );
    }
    const message = errorMessage(error);
    return finish({ state: 'logged_in', canPublish: false, ...base, error: message }, notReached(message));
  }

  const login: ReleaseLoginStatus = {
    state: 'logged_in',
    canPublish: Array.isArray(user.permissions) && user.permissions.includes(PUBLISH_PERMISSION),
    email: user.email,
    ...base,
  };

  let server: ReleaseServerStatus;
  try {
    server = { current: await latestRelease(client), reachable: true };
  } catch (error) {
    server = notReached(errorMessage(error));
  }
  return finish(login, server);
}
