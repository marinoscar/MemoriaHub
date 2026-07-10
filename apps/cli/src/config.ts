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
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function loadConfig(): CliConfig | null {
  const p = configPath();
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw) as CliConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: CliConfig): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(config, null, 2), { mode: 0o600 });
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
