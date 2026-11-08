// =============================================================================
// Tripwire: only allowlisted files reach PrismaSystemService (RETRO-D1, #563)
// =============================================================================
//
// The system client is the ONE way to read or write across organizations: its
// transactions set `app.rls_bypass`. A file that reaches it by accident has
// quietly opted out of tenant isolation, so every one is a reviewed decision:
// this list. The scan reads every source file under src/ (specs excluded) for
// the class name in code (comments stripped), and fails for a file that is not
// on the list AND for an entry that no longer mentions it (a stale allowlist).
// Each entry names the `SystemAccessReason` its acquisitions use.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');

/** Files that may mention PrismaSystemService, each with why. Relative to apps/api/src. */
const ALLOWLIST: Record<string, string> = {
  'prisma/prisma-system.service.ts': 'defines it',
  'prisma/prisma.module.ts': 'provides and exports it',
  'platform/storage/storage-host.module.ts':
    "purge and admin-aggregate: the storage slice's STORAGE_SYSTEM_DATA port: the stale-upload sweep (purge), " +
    'the stranded-object count and the migration planner (admin-aggregate)',
  'platform/db-backup/db-backup-system-data.adapter.ts':
    "doctor: the db-backup slice's DB_BACKUP_SYSTEM_DATA port: the backup.rls-bypass check's read-only row counts",
  'media/thumbnail-repair.handler.ts':
    'media-housekeeping: the global thumbnail_repair sweep finds and counts repair attempts across organizations',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [full] : [];
  });
}

/** The code of a file with comments removed, so a mention in prose never counts. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

describe('PrismaSystemService injection boundary', () => {
  const mentions = sources(SRC)
    .filter((file) => /\bPrismaSystemService\b/.test(code(file)))
    .map((file) => relative(SRC, file).split(sep).join('/'))
    .sort();

  it('finds the injections (guards against a scan that matches nothing)', () => {
    expect(mentions.length).toBeGreaterThanOrEqual(4);
  });

  it('is mentioned only by allowlisted files', () => {
    expect(mentions.filter((file) => !(file in ALLOWLIST))).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    expect(Object.keys(ALLOWLIST).filter((file) => !mentions.includes(file))).toEqual([]);
  });
});
