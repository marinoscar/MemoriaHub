import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CliConfig {
  serverUrl: string;
  pat: string;
}

function configDir(): string {
  return path.join(os.homedir(), '.memoriahub');
}

function configPath(): string {
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
  const dir = path.join(configDir(), 'manifests');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function requireConfig(): CliConfig {
  const cfg = loadConfig();
  if (!cfg) {
    console.error(
      'Not logged in. Run `memoriahub login` to configure your server URL and PAT.',
    );
    process.exit(1);
  }
  return cfg;
}
