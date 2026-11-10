import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The file name of the memoriahub lock, relative to the app's `prisma` folder.
 *
 * @stability experimental
 */
export const MEMORIAHUB_LOCK_FILE = 'memoriahub.lock';

/**
 * A lock file, manifest or inventory that failed validation, or a merge the
 * tool refuses. The message names the file and the offending entry.
 *
 * @stability experimental
 */
export class MemoriahubLockError extends Error {
  /** @param message - What is wrong and where. */
  constructor(message: string) {
    super(message);
    this.name = 'MemoriahubLockError';
  }
}

/**
 * SHA-256 of some bytes, as lowercase hex. Equals Prisma's
 * `_prisma_migrations.checksum` for a `migration.sql` file.
 *
 * @param bytes - The file bytes (comments and whitespace count), or a string hashed as UTF-8.
 * @returns 64 hex characters.
 * @stability experimental
 */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, sortKeys(source[key])]));
  }
  return value;
}

/**
 * Serialises JSON deterministically, the way `platform.lock` is written: keys
 * sorted at every level, arrays in their given order, two-space indent and one
 * trailing newline. The same input always gives the same bytes, so diffs stay
 * stable.
 *
 * @param value - Any JSON value.
 * @returns The file contents.
 * @stability experimental
 */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/**
 * One installed domain migration in `prisma/memoriahub.lock`.
 *
 * @stability experimental
 */
export interface MemoriahubLockEntry {
  /** `memoriahub:` plus the package migration id, for example `memoriahub:20261110200000_domain_baseline`. */
  originId: string;
  /**
   * The directory under the app's `prisma/migrations` the migration was installed as; `null` for a
   * baseline the app's own history already contains (see `adopted`): nothing was written.
   */
  installedDir: string | null;
  /**
   * `true` for a baseline migration an app with MemoriaHub history adopted instead of installing: the
   * app's existing migrations already created every object it holds, so no directory exists for it and
   * no database ever runs it. The package hash is still recorded, so a change to the baseline is caught.
   */
  adopted?: true;
  /** SHA-256 of the installed `migration.sql` bytes; equals the package manifest's value. */
  sha256: string;
}

/**
 * The contents of `prisma/memoriahub.lock`: proof that the app's installed domain
 * migrations are byte-identical to the package's.
 *
 * @stability experimental
 */
export interface MemoriahubLock {
  /** The lock format version; a reader refuses another value. */
  lockVersion: 1;
  /** The package version that last installed a migration into this app. */
  memoriahubDbVersion: string;
  /** One entry per installed migration, in package order. */
  migrations: MemoriahubLockEntry[];
}

/**
 * An empty lock for an app that has installed nothing.
 *
 * @param memoriahubDbVersion - The package version.
 * @returns A lock without migrations.
 * @stability experimental
 */
export function emptyMemoriahubLock(memoriahubDbVersion: string): MemoriahubLock {
  return { lockVersion: 1, memoriahubDbVersion, migrations: [] };
}

/**
 * Parses and validates the text of a `memoriahub.lock`.
 *
 * @param text - The file contents.
 * @param source - A label for error messages, usually the path.
 * @returns The validated lock.
 * @throws MemoriahubLockError when the JSON or its shape is invalid.
 * @stability experimental
 */
export function parseMemoriahubLock(text: string, source = 'memoriahub.lock'): MemoriahubLock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new MemoriahubLockError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  const lock = raw as Partial<MemoriahubLock> | null;
  if (lock === null || typeof lock !== 'object' || lock.lockVersion !== 1) {
    throw new MemoriahubLockError(`${source}: lockVersion must be 1`);
  }
  if (typeof lock.memoriahubDbVersion !== 'string' || lock.memoriahubDbVersion === '') {
    throw new MemoriahubLockError(`${source}: memoriahubDbVersion must be a non-empty string`);
  }
  if (!Array.isArray(lock.migrations)) throw new MemoriahubLockError(`${source}: migrations must be an array`);
  lock.migrations.forEach((entry, index) => {
    const e = entry as Partial<MemoriahubLockEntry>;
    if (typeof e?.originId !== 'string' || !e.originId.startsWith('memoriahub:')) {
      throw new MemoriahubLockError(`${source}: migrations[${index}].originId must start with "memoriahub:"`);
    }
    if (e.adopted === true) {
      if (e.installedDir !== null) throw new MemoriahubLockError(`${source}: migrations[${index}] is adopted, so installedDir must be null`);
    } else if (typeof e.installedDir !== 'string' || e.installedDir === '') {
      throw new MemoriahubLockError(`${source}: migrations[${index}].installedDir must be a non-empty string`);
    }
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw new MemoriahubLockError(`${source}: migrations[${index}].sha256 must be 64 lowercase hex characters`);
    }
  });
  return { lockVersion: 1, memoriahubDbVersion: lock.memoriahubDbVersion, migrations: lock.migrations as MemoriahubLockEntry[] };
}

/**
 * Reads `memoriahub.lock` if it exists.
 *
 * @param file - Path of the lock file.
 * @returns The lock, or `undefined` when the file does not exist.
 * @throws MemoriahubLockError when the file exists and is invalid.
 * @stability experimental
 */
export function readMemoriahubLock(file: string): MemoriahubLock | undefined {
  if (!existsSync(file)) return undefined;
  return parseMemoriahubLock(readFileSync(file, 'utf8'), file);
}

/**
 * Serialises a lock for writing to `memoriahub.lock`.
 *
 * @param lock - The lock.
 * @returns The file contents (see {@link serializeJson}).
 * @stability experimental
 */
export function serializeMemoriahubLock(lock: MemoriahubLock): string {
  return serializeJson(lock);
}

/**
 * A raw-SQL index as `platform.lock` `rawSqlIndexes` records it.
 *
 * @stability experimental
 */
export interface LockedRawSqlIndex {
  /** The index name. */
  name: string;
  /** `pg_indexes.indexdef` of the index. */
  definition: string;
}

/**
 * The parsed `platform.lock`, kept as a plain object so every field this tool
 * does not own (migrations, deviations, policies) is written back untouched.
 *
 * @stability experimental
 */
export type PlatformLockDocument = Record<string, unknown>;

/**
 * Reads `platform.lock` if it exists.
 *
 * @param file - Path of the lock file.
 * @returns The document, or `undefined` when the file does not exist.
 * @throws MemoriahubLockError when the file is not a JSON object.
 * @stability experimental
 */
export function readPlatformLock(file: string): PlatformLockDocument | undefined {
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new MemoriahubLockError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MemoriahubLockError(`${file} must be a JSON object`);
  }
  return raw as PlatformLockDocument;
}

/**
 * Collapses whitespace so two index definitions compare equal across formatting.
 *
 * @param definition - A `CREATE ... INDEX` statement.
 * @returns The statement with runs of whitespace as one space, trimmed.
 * @stability experimental
 */
export function normaliseDefinition(definition: string): string {
  return definition.replace(/\s+/g, ' ').trim();
}

/**
 * What {@link mergePlatformLock} changed.
 *
 * @stability experimental
 */
export interface PlatformLockMerge {
  /** The document to write back (a new object; the input is not modified). */
  document: PlatformLockDocument;
  /** Names of the raw-SQL indexes that were added. */
  addedIndexes: string[];
  /** Directories appended to `appMigrations`. */
  addedDirs: string[];
}

/**
 * Merges the package's raw-SQL indexes into `rawSqlIndexes` and the installed
 * directories into `appMigrations` of a `platform.lock` document.
 *
 * Indexes are added by name; a name that is already listed must carry the same
 * definition (whitespace aside) or the merge is refused. `appMigrations` is
 * extended only when the lock already has the field: a lock without it skips
 * the platform's ordering rule until its next sync, and adding the field here
 * would switch the rule on for directories this tool does not know.
 *
 * @param document - The parsed `platform.lock`.
 * @param indexes - The package's raw-SQL indexes (`name`, `definition`).
 * @param installedDirs - Every directory the memoriahub lock records.
 * @returns The merged document and what was added.
 * @throws MemoriahubLockError when an index of the same name has another definition.
 * @stability experimental
 */
export function mergePlatformLock(
  document: PlatformLockDocument,
  indexes: readonly LockedRawSqlIndex[],
  installedDirs: readonly string[],
): PlatformLockMerge {
  const listed = Array.isArray(document.rawSqlIndexes) ? ([...document.rawSqlIndexes] as LockedRawSqlIndex[]) : [];
  const byName = new Map(listed.map((entry) => [entry.name, entry]));
  const addedIndexes: string[] = [];
  for (const index of indexes) {
    const existing = byName.get(index.name);
    if (existing === undefined) {
      const entry = { name: index.name, definition: index.definition };
      listed.push(entry);
      byName.set(index.name, entry);
      addedIndexes.push(index.name);
    } else if (normaliseDefinition(existing.definition) !== normaliseDefinition(index.definition)) {
      throw new MemoriahubLockError(
        `platform.lock rawSqlIndexes already lists ${index.name} with a different definition; ` +
          `the lock has "${normaliseDefinition(existing.definition)}", the package has "${normaliseDefinition(index.definition)}"`,
      );
    }
  }
  listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const addedDirs: string[] = [];
  let appMigrations = document.appMigrations;
  if (Array.isArray(appMigrations)) {
    const known = new Set(appMigrations as string[]);
    const next = [...(appMigrations as string[])];
    for (const dir of installedDirs) {
      if (!known.has(dir)) {
        next.push(dir);
        known.add(dir);
        addedDirs.push(dir);
      }
    }
    next.sort();
    appMigrations = next;
  }
  const merged: PlatformLockDocument = { ...document, rawSqlIndexes: listed };
  if (appMigrations !== undefined) merged.appMigrations = appMigrations;
  return { document: merged, addedIndexes, addedDirs };
}
