import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { configDir } from '../paths.js';

// =============================================================================
// Config and environment compatibility  (issue #577, RETRO-F3)
// =============================================================================
//
// `~/.memoriahub/config.json` is now shared by two readers: the app's commands
// (src/config.ts) and the platform's `login` / `config` / `api`. The platform
// names the credential `token` and its expiry `expiresAt`; 1.3.x wrote `pat`
// and `patExpiresAt`. Three things keep an upgraded install logged in:
//
//   1. `migrateLegacyConfig` renames the two keys once, backs the old file up to
//      `config.json.bak` (once, never overwritten) and leaves every other field
//      (`serverUrl`, `activeCircleId`, `nodeId`, the `node` block, ...) as it was.
//   2. src/config.ts reads either spelling, so a file this migration could not
//      write (read-only home) still works.
//   3. `mergeAfterPlatformLogin` puts the app-only fields back after the
//      platform's `login` replaced the file (it writes only its own fields).
//
// The environment: the platform reads `MEMORIAHUB_SERVER_URL`, 1.3.x workers
// are configured with `MEMORIAHUB_URL`. `applyEnvCompat` mirrors the old name
// onto the new one when the new one is unset. `MEMORIAHUB_TOKEN` is shared.
// =============================================================================

export type MigrationResult = 'migrated' | 'unchanged' | 'absent' | 'failed';

function configFile(dir: string): string {
  return path.join(dir, 'config.json');
}

function readObject(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic 0600 write: a brand-new file renamed over the target, as the platform does. */
function writePrivate(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'w' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * One-time, idempotent rename of `pat` -> `token` and `patExpiresAt` -> `expiresAt`.
 *
 * Never throws: a container with a read-only home keeps running on the
 * environment (and on the dual-spelling reader in src/config.ts).
 *
 * @param dir - The state directory; defaults to `~/.memoriahub` / `MEMORIAHUB_STATE_DIR`.
 */
export function migrateLegacyConfig(dir: string = configDir()): MigrationResult {
  const file = configFile(dir);
  if (!fs.existsSync(file)) return 'absent';
  const raw = readObject(file);
  if (raw === undefined) return 'unchanged';
  if (!('pat' in raw) && !('patExpiresAt' in raw)) return 'unchanged';

  try {
    const backup = `${file}.bak`;
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(file, backup);
      fs.chmodSync(backup, 0o600);
    }
    const { pat, patExpiresAt, ...rest } = raw;
    const next: Record<string, unknown> = { ...rest };
    const hasToken = typeof raw['token'] === 'string' && raw['token'] !== '';
    if (!hasToken && typeof pat === 'string' && pat) next['token'] = pat;
    if (!raw['expiresAt'] && typeof patExpiresAt === 'string' && patExpiresAt) next['expiresAt'] = patExpiresAt;
    writePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
    return 'migrated';
  } catch {
    return 'failed';
  }
}

/** Fields that only the app's commands own; the platform's `login` does not write them. */
const PLATFORM_FIELDS = new Set(['serverUrl', 'token', 'expiresAt', 'tokenId', 'tokenName', 'updatedAt']);

/** What `login` may replace; everything else in the file is app state worth keeping. */
export function snapshotAppFields(dir: string = configDir()): Record<string, unknown> {
  const raw = readObject(configFile(dir)) ?? {};
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PLATFORM_FIELDS.has(key) && key !== 'pat' && key !== 'patExpiresAt') kept[key] = value;
  }
  return kept;
}

/**
 * After the platform's `login` rewrote the file with only its own fields, put
 * the app's fields (`activeCircleId`, `nodeId`, `node`, ...) back.
 *
 * The platform resolves its config directory from the home directory and ignores
 * `MEMORIAHUB_STATE_DIR`; when the two differ the fresh credentials are copied
 * into the state directory so the app's commands see them.
 *
 * @param appFields - The result of {@link snapshotAppFields} taken before `login`.
 * @param platformDir - Where the platform wrote (default `~/.memoriahub`).
 * @param dir - The app's state directory.
 */
export function mergeAfterPlatformLogin(
  appFields: Record<string, unknown>,
  platformDir: string = path.join(os.homedir(), '.memoriahub'),
  dir: string = configDir(),
): MigrationResult {
  try {
    const written = readObject(configFile(platformDir));
    if (written === undefined) return 'absent';
    const merged: Record<string, unknown> = { ...appFields };
    for (const [key, value] of Object.entries(written)) {
      if (PLATFORM_FIELDS.has(key)) merged[key] = value;
    }
    fs.mkdirSync(dir, { recursive: true });
    writePrivate(configFile(dir), `${JSON.stringify(merged, null, 2)}\n`);
    return 'migrated';
  } catch {
    return 'failed';
  }
}

/**
 * Mirrors `MEMORIAHUB_URL` onto the platform's `MEMORIAHUB_SERVER_URL` when the
 * latter is unset. Returns the variables to set; the caller applies them.
 */
export function applyEnvCompat(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  const legacyUrl = env['MEMORIAHUB_URL']?.trim();
  if (legacyUrl && !env['MEMORIAHUB_SERVER_URL']?.trim()) out['MEMORIAHUB_SERVER_URL'] = legacyUrl;
  return out;
}
