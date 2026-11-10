import * as fs from 'fs';
import * as path from 'path';
import { ui } from './ui.js';
import { configDir } from './paths.js';

import { parseActiveOwnerScope, type ActiveOwnerScope } from './owner-scope.js';

export { ownerScopeFields, parseActiveOwnerScope, type ActiveOwnerScope } from './owner-scope.js';

export interface CliConfig {
  serverUrl: string;
  pat: string;
  /**
   * The library uploads go to (RETRO-I6, #588), the CLI's counterpart of the web's
   * `user_settings.activeOwnerScope`. Written by `groups use` together with
   * {@link activeCircleId}.
   */
  activeOwnerScope?: ActiveOwnerScope;
  /**
   * The resolved scope id the commands send (a group id, or the personal library's id).
   * @deprecated RETRO-I6 (#588): read the choice from {@link activeOwnerScope}. Still
   * written alongside it, so a CLI older than 1.5.3 sharing this file keeps uploading to
   * the same library, and still read when `activeOwnerScope` is absent (a pre-1.5.3 file).
   */
  activeCircleId?: string;
  /**
   * ISO 8601 expiry timestamp of the stored PAT.  Written by `memoriahub login`
   * when the device-flow token response includes an expiresIn field.  Used by
   * the pre-flight check to warn before large imports when the token is nearly
   * expired.  Absent for tokens created via --token (expiry is unknown).
   */
  patExpiresAt?: string;

  /**
   * Worker-node identity assigned by `POST /api/nodes/register`.  Persisted so
   * `node start` / `node status` / `node stop` can operate without re-registering.
   * Absent until the machine has been registered as a worker node.
   */
  nodeId?: string;

  /**
   * Persisted worker-node settings.  All optional for back-compat — a config
   * written before the node feature existed simply omits this key.
   */
  node?: NodeConfig;
}

export interface NodeConfig {
  /** Worker pool concurrency (simultaneous jobs processed). */
  concurrency?: number;
  /** Job types this node advertises as eligible to process. */
  eligibleTypes?: string[];
  /** Interval (ms) between claim polls when the queue is idle. */
  pollIntervalMs?: number;
  /** Human-friendly node name shown server-side. */
  name?: string;
  /**
   * Face-detection provider this node uses for local compute. CompreFace is
   * the only accepted value (Human/Rekognition were removed — issue #113);
   * the field/env-var mechanism is kept structurally in case a future
   * provider is added, but any other explicit value is rejected outright
   * rather than silently coerced.
   */
  faceProvider?: 'compreface';
  /**
   * Base URL of a locally-running compreface-core sidecar this node calls for
   * face detection. Only meaningful when faceProvider is 'compreface'.
   * Default: http://localhost:3000.
   */
  comprefaceUrl?: string;
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

/**
 * True when the environment alone provides a usable config — both
 * MEMORIAHUB_URL and MEMORIAHUB_TOKEN are set. Used by loadConfig() to
 * synthesize a config with no file on disk (headless/container deployments)
 * and by saveConfig() to downgrade write failures to warnings in that mode.
 */
export function envConfigComplete(): boolean {
  return Boolean(
    process.env['MEMORIAHUB_URL']?.trim() && process.env['MEMORIAHUB_TOKEN']?.trim(),
  );
}

/** Parse a positive-integer env var; warn and return undefined when invalid. */
function envInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw || n <= 0) {
    ui.warn(`Ignoring invalid ${name}="${raw}" (expected a positive integer).`);
    return undefined;
  }
  return n;
}

/**
 * Overlay MEMORIAHUB_* environment variables onto a file-loaded config —
 * env wins per-field. When `base` is null (no config file) and the env is
 * complete (MEMORIAHUB_URL + MEMORIAHUB_TOKEN), a config is synthesized from
 * env alone; otherwise null is passed through so the no-file-no-env case
 * keeps its existing semantics.
 */
function applyEnvOverlay(base: CliConfig | null): CliConfig | null {
  const env = process.env;
  const serverUrl = env['MEMORIAHUB_URL']?.trim();
  const pat = env['MEMORIAHUB_TOKEN']?.trim();

  let cfg: CliConfig;
  if (base) {
    cfg = { ...base };
    if (serverUrl) cfg.serverUrl = serverUrl;
    if (pat) cfg.pat = pat;
  } else if (serverUrl && pat) {
    cfg = { serverUrl, pat };
  } else {
    return null;
  }

  const nodeId = env['MEMORIAHUB_NODE_ID']?.trim();
  if (nodeId) cfg.nodeId = nodeId;

  const node: NodeConfig = { ...cfg.node };
  let nodeTouched = false;

  const name = env['MEMORIAHUB_NODE_NAME']?.trim();
  if (name) {
    node.name = name;
    nodeTouched = true;
  }

  const concurrency = envInt('MEMORIAHUB_CONCURRENCY');
  if (concurrency !== undefined) {
    node.concurrency = concurrency;
    nodeTouched = true;
  }

  const eligibleRaw = env['MEMORIAHUB_ELIGIBLE_TYPES'];
  if (eligibleRaw !== undefined) {
    const types = eligibleRaw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (types.length > 0) {
      node.eligibleTypes = types;
      nodeTouched = true;
    }
  }

  const pollIntervalMs = envInt('MEMORIAHUB_POLL_INTERVAL_MS');
  if (pollIntervalMs !== undefined) {
    node.pollIntervalMs = pollIntervalMs;
    nodeTouched = true;
  }

  const faceProvider = env['MEMORIAHUB_FACE_PROVIDER']?.trim();
  if (faceProvider) {
    if (faceProvider === 'compreface') {
      node.faceProvider = faceProvider;
      nodeTouched = true;
    } else {
      // Reject outright rather than silently coercing/ignoring — an operator
      // running a stale config (e.g. MEMORIAHUB_FACE_PROVIDER=human from
      // before issue #113) must get an unambiguous failure, not confusing
      // downstream behavior from a silently-dropped setting.
      ui.error(
        `Invalid MEMORIAHUB_FACE_PROVIDER="${faceProvider}". Only 'compreface' is supported ` +
          '(Human and AWS Rekognition face providers were removed).',
      );
      process.exit(1);
    }
  }

  const comprefaceUrl = env['MEMORIAHUB_COMPREFACE_URL']?.trim();
  if (comprefaceUrl) {
    node.comprefaceUrl = comprefaceUrl;
    nodeTouched = true;
  }

  if (nodeTouched) cfg.node = node;

  return cfg;
}

/**
 * Read `config.json` as a plain object, or null when absent/unreadable.
 *
 * The file is shared with the platform CLI (`login`, `config`, `api`), which
 * names the credential `token` and its expiry `expiresAt`; releases before 1.4
 * wrote `pat` / `patExpiresAt`. Both spellings are understood here so an
 * install that has not been migrated yet (extensions/config-compat.ts) keeps
 * working.
 */
export function readRawConfigFile(): Record<string, unknown> | null {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through: unreadable is treated as "no file", as before
  }
  return null;
}

/** File shape (platform names, legacy names tolerated) to the in-memory CliConfig. */
export function fromFileShape(raw: Record<string, unknown>): CliConfig {
  const { token, expiresAt, pat, patExpiresAt, activeOwnerScope, ...rest } = raw;
  const cfg = { ...rest } as unknown as CliConfig;
  // RETRO-I6 (#588): `activeOwnerScope` wins; a group names its scope id directly. `me`
  // keeps the resolved personal-library id stored beside it in `activeCircleId`. A file
  // without `activeOwnerScope` (older CLI) is read exactly as before.
  const scope = parseActiveOwnerScope(activeOwnerScope);
  if (scope) {
    cfg.activeOwnerScope = scope;
    if (scope.kind === 'group') cfg.activeCircleId = scope.groupId;
  }
  const credential = typeof token === 'string' && token ? token : pat;
  if (typeof credential === 'string') cfg.pat = credential;
  const expiry = typeof expiresAt === 'string' && expiresAt ? expiresAt : patExpiresAt;
  if (typeof expiry === 'string') cfg.patExpiresAt = expiry;
  return cfg;
}

/** The in-memory CliConfig to the file shape the platform CLI also reads. */
export function toFileShape(config: CliConfig, existing?: Record<string, unknown> | null): Record<string, unknown> {
  const { pat, patExpiresAt, ...rest } = config;
  // Keep what other writers put in the file (tokenId, tokenName, updatedAt, ...)
  // but never a stale legacy credential.
  const { pat: _oldPat, patExpiresAt: _oldExpiry, expiresAt: _oldExpiresAt, ...kept } = existing ?? {};
  const out: Record<string, unknown> = { ...kept, ...rest, token: pat };
  if (patExpiresAt !== undefined) out['expiresAt'] = patExpiresAt;
  return out;
}

export function loadConfig(): CliConfig | null {
  const raw = readRawConfigFile();
  return applyEnvOverlay(raw ? fromFileShape(raw) : null);
}

export function saveConfig(config: CliConfig): void {
  const dir = configDir();
  const p = configPath();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(toFileShape(config, readRawConfigFile()), null, 2), { mode: 0o600 });
  } catch (err) {
    // Env-driven headless deployments (e.g. containers with a read-only home)
    // must not crash on a best-effort persistence write — the env already
    // carries a complete config. File-based flows keep failing loudly.
    if (envConfigComplete()) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.warn(`Could not persist config to ${p} (${msg}); continuing with env-based config.`);
      return;
    }
    throw err;
  }
}

export function manifestsDir(): string {
  // Re-exported for backwards-compatibility; actual impl lives in paths.ts.
  const dir = path.join(configDir(), 'manifests');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function requireConfig(): CliConfig {
  const cfg = loadConfig();
  if (!cfg) {
    ui.error('Not logged in. Run `memoriahub login` to configure your server URL and PAT.');
    process.exit(1);
  }
  return cfg;
}
