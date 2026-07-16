import * as fs from 'fs';
import * as path from 'path';
import { ui } from './ui.js';
import { configDir } from './paths.js';

export interface CliConfig {
  serverUrl: string;
  pat: string;
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
  /** Face-detection provider this node uses for local compute (default 'human'). */
  faceProvider?: 'human' | 'compreface';
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
    if (faceProvider === 'human' || faceProvider === 'compreface') {
      node.faceProvider = faceProvider;
      nodeTouched = true;
    } else {
      ui.warn(
        `Ignoring invalid MEMORIAHUB_FACE_PROVIDER="${faceProvider}" (expected 'human' or 'compreface').`,
      );
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

export function loadConfig(): CliConfig | null {
  const p = configPath();
  let fileConfig: CliConfig | null = null;
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      fileConfig = JSON.parse(raw) as CliConfig;
    } catch {
      fileConfig = null;
    }
  }
  return applyEnvOverlay(fileConfig);
}

export function saveConfig(config: CliConfig): void {
  const dir = configDir();
  const p = configPath();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2), { mode: 0o600 });
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
