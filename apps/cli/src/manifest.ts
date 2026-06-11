import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { manifestsDir } from './config';

export type FileStatus = 'uploaded' | 'pending' | 'failed';

export interface ManifestEntry {
  sha256: string;
  mediaItemId: string | null;
  uploadedAt: string | null;
  status: FileStatus;
}

export interface Manifest {
  folderPath: string;
  lastSyncAt: string | null;
  files: Record<string, ManifestEntry>;
}

function manifestPath(folderPath: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(path.resolve(folderPath))
    .digest('hex');
  return path.join(manifestsDir(), `${hash}.json`);
}

export function loadManifest(folderPath: string): Manifest {
  const p = manifestPath(folderPath);
  if (!fs.existsSync(p)) {
    return {
      folderPath: path.resolve(folderPath),
      lastSyncAt: null,
      files: {},
    };
  }
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw) as Manifest;
  } catch {
    return {
      folderPath: path.resolve(folderPath),
      lastSyncAt: null,
      files: {},
    };
  }
}

export function saveManifest(folderPath: string, manifest: Manifest): void {
  const p = manifestPath(folderPath);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

export function loadAllManifests(): Array<Manifest & { manifestFile: string }> {
  const dir = manifestsDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const results: Array<Manifest & { manifestFile: string }> = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const m = JSON.parse(raw) as Manifest;
      results.push({ ...m, manifestFile: f });
    } catch {
      // skip malformed manifest
    }
  }
  return results;
}
