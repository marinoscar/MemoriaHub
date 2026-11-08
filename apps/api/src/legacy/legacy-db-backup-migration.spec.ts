import {
  COPY_LEGACY_RUNS_SQL,
  LEGACY_DATABASE_BACKUP_SETTINGS_KEY,
  LINK_PRE_RESTORE_SQL,
  applyRunCopy,
  migrateDatabaseBackupSettings,
  planRunCopy,
  transformDatabaseBackupSettings,
  type SqlClient,
} from './legacy-db-backup-migration';

/** MemoriaHub's stored `databaseBackup` value before the slice (its old defaults). */
const LEGACY_VALUE = {
  enabled: true,
  frequency: 'weekly',
  dayOfWeek: 3,
  dayOfMonth: 1,
  timeOfDay: '02:00',
  timezone: 'America/Costa_Rica',
  retentionCount: 7,
  storageProvider: null,
  runStaleMinutes: 30,
  compressionLevel: 1,
  restoreRollbackMode: 'pre_restore_dump',
  oldDatabaseRetentionHours: 168,
};

describe('transformDatabaseBackupSettings', () => {
  it('rewrites the three shape differences and keeps every other value', () => {
    const { next, changed, warnings } = transformDatabaseBackupSettings(LEGACY_VALUE);
    expect(changed).toBe(true);
    expect(warnings).toEqual([]);
    expect(next).toEqual({
      ...LEGACY_VALUE,
      storageProvider: '',
      restoreRollbackMode: 'drop_database',
      nodeOffloadEnabled: false,
    });
  });

  it('is idempotent: its own output comes back unchanged', () => {
    const once = transformDatabaseBackupSettings(LEGACY_VALUE).next;
    const twice = transformDatabaseBackupSettings(once);
    expect(twice.changed).toBe(false);
    expect(twice.next).toEqual(once);
  });

  it('keeps a pinned provider and retain_database as they are', () => {
    const { next } = transformDatabaseBackupSettings({ ...LEGACY_VALUE, storageProvider: 'r2', restoreRollbackMode: 'retain_database' });
    expect(next.storageProvider).toBe('r2');
    expect(next.restoreRollbackMode).toBe('retain_database');
  });

  it('resets an unknown timezone and frequency with a warning', () => {
    const { next, warnings } = transformDatabaseBackupSettings({ ...LEGACY_VALUE, timezone: 'Mars/Olympus', frequency: 'hourly' });
    expect(next.timezone).toBe('UTC');
    expect(next.frequency).toBe('daily');
    expect(warnings).toHaveLength(2);
  });

  it('clamps a number outside the platform bounds and drops a non-number', () => {
    const { next, warnings } = transformDatabaseBackupSettings({ ...LEGACY_VALUE, compressionLevel: 12, retentionCount: 'seven' });
    expect(next.compressionLevel).toBe(9);
    expect(next).not.toHaveProperty('retentionCount');
    expect(warnings).toHaveLength(2);
  });

  it('mirrors retentionCount into an existing retention.count (the platform alias)', () => {
    const { next } = transformDatabaseBackupSettings({ ...LEGACY_VALUE, retention: { count: 3, maxAgeDays: 30 } });
    expect(next.retention).toEqual({ count: 7, maxAgeDays: 30 });
  });

  it('leaves a never-written namespace alone', () => {
    expect(transformDatabaseBackupSettings(undefined)).toEqual({ next: {}, changes: [], warnings: [], changed: false });
  });
});

/** A scripted client: answers by the first matching needle and records every statement. */
function scriptedClient(answers: Array<[RegExp, { rows: unknown[]; rowCount?: number }]>): SqlClient & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query<R>(text: string) {
      sql.push(text.trim());
      const hit = answers.find(([needle]) => needle.test(text));
      return (hit ? hit[1] : { rows: [], rowCount: 0 }) as { rows: R[]; rowCount?: number };
    },
  };
}

describe('migrateDatabaseBackupSettings', () => {
  it('a dry run reads and writes nothing', async () => {
    const client = scriptedClient([[/SELECT value FROM system_settings/, { rows: [{ value: { databaseBackup: LEGACY_VALUE } }] }]]);
    const result = await migrateDatabaseBackupSettings(client, false);
    expect(result.written).toBe(false);
    expect(client.sql.some((s) => s.startsWith('UPDATE'))).toBe(false);
    expect(client.sql.at(-1)).toBe('ROLLBACK');
  });

  it('apply rewrites the namespace and keeps the original once, under a row lock', async () => {
    const client = scriptedClient([[/SELECT value FROM system_settings/, { rows: [{ value: { ui: { x: 1 }, databaseBackup: LEGACY_VALUE } }] }]]);
    const updates: unknown[] = [];
    const query = client.query.bind(client);
    client.query = (async (text: string, values?: unknown[]) => {
      if (text.startsWith('UPDATE')) updates.push(JSON.parse(String(values?.[1])));
      return query(text, values);
    }) as SqlClient['query'];

    const result = await migrateDatabaseBackupSettings(client, true);

    expect(result).toMatchObject({ written: true, keptOriginal: true });
    expect(client.sql.find((s) => s.startsWith('SELECT value'))).toContain('FOR UPDATE');
    expect(updates).toHaveLength(1);
    const doc = updates[0] as Record<string, unknown>;
    expect(doc[LEGACY_DATABASE_BACKUP_SETTINGS_KEY]).toEqual(LEGACY_VALUE);
    expect(doc.databaseBackup).toMatchObject({ storageProvider: '', restoreRollbackMode: 'drop_database' });
    expect(doc.ui).toEqual({ x: 1 });
    expect(client.sql.at(-1)).toBe('COMMIT');
  });

  it('apply on an already-migrated value writes nothing', async () => {
    const migrated = transformDatabaseBackupSettings(LEGACY_VALUE).next;
    const client = scriptedClient([
      [/SELECT value FROM system_settings/, { rows: [{ value: { databaseBackup: migrated, [LEGACY_DATABASE_BACKUP_SETTINGS_KEY]: LEGACY_VALUE } }] }],
    ]);
    const result = await migrateDatabaseBackupSettings(client, true);
    expect(result.written).toBe(false);
    expect(client.sql.some((s) => s.startsWith('UPDATE'))).toBe(false);
  });
});

describe('the run-history copy', () => {
  it('copies by id with ON CONFLICT DO NOTHING, archive rows only, never the in-flight ones', () => {
    expect(COPY_LEGACY_RUNS_SQL).toMatch(/INSERT INTO database_backup_runs/);
    expect(COPY_LEGACY_RUNS_SQL).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(COPY_LEGACY_RUNS_SQL).toMatch(/l\.storage_key IS NOT NULL/);
    expect(COPY_LEGACY_RUNS_SQL).toMatch(/l\.status IN \('completed', 'failed', 'stale'\)/);
    // Users are re-resolved, never copied blindly (a deleted user must not abort the copy).
    expect(COPY_LEGACY_RUNS_SQL).toMatch(/SELECT u\.id FROM users u WHERE u\.id = l\.created_by_id/);
    // The legacy table is only read.
    expect(COPY_LEGACY_RUNS_SQL).not.toMatch(/(UPDATE|DELETE FROM)\s+mh_legacy/);
    expect(LINK_PRE_RESTORE_SQL).toMatch(/^\s*UPDATE database_backup_runs d/);
    expect(LINK_PRE_RESTORE_SQL).toMatch(/d\.pre_restore_backup_id IS NULL/);
  });

  it('plans from the counts', async () => {
    const client = scriptedClient([
      [/count\(\*\)/, { rows: [{ total: 5, with_archive: 4, already_copied: 1 }] }],
      [/status IN \('pending', 'running'\)/, { rows: [] }],
    ]);
    expect(await planRunCopy(client)).toEqual({ total: 5, withArchive: 4, alreadyCopied: 1, toCopy: 3, withoutArchive: 1, active: [] });
  });

  it('refuses while a legacy backup or restore is in flight, before opening a transaction', async () => {
    const client = scriptedClient([[/status IN \('pending', 'running'\)/, { rows: [{ id: 'run-a', status: 'running' }] }]]);
    await expect(applyRunCopy(client)).rejects.toThrow(/run-a:running/);
    expect(client.sql).not.toContain('BEGIN');
  });

  it('copies and links in one transaction', async () => {
    const client = scriptedClient([
      [/INSERT INTO database_backup_runs/, { rows: [], rowCount: 3 }],
      [/SET pre_restore_backup_id/, { rows: [], rowCount: 1 }],
    ]);
    expect(await applyRunCopy(client)).toEqual({ copied: 3, linked: 1 });
    expect(client.sql.filter((s) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s))).toEqual(['BEGIN', 'COMMIT']);
  });
});
