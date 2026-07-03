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
