// Schema/migration-drift guard for the Notification Center foundation
// (issue #244, child of epic #240).
//
// WHY THIS TEST EXISTS AND WHAT IT DOES NOT DO:
// This repo's CI has no live Postgres (see .github/workflows/ci.yml and
// docs/ci-known-failing-tests.md — apps/api integration specs boot the
// AppModule over a MOCKED Prisma). A real insert-two-rows-and-assert-a-
// unique-violation test cannot run here. This suite instead reads the
// migration SQL and schema.prisma straight off disk with plain string/regex
// parsing (no DB, no Prisma client, no NestJS module) and asserts the exact
// shape of the load-bearing dedup invariant:
//
//   At most one LIVE (dismissed_at IS NULL) notification row may exist per
//   (user_id, circle_id, type) for the four review_queue_* STATE types —
//   never for the four EVENT types, which must always be exempt.
//
// A future edit that renames the index, changes its column list, narrows or
// widens its WHERE predicate (e.g. accidentally folding an event type into
// the IN-list, which would wrongly dedup per-occurrence notifications down
// to one row), or drops one of the Notification model's five documented
// indexes will fail this test.

import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '../../prisma/migrations/20260805000000_add_notifications/migration.sql',
);
const SCHEMA_PRISMA_PATH = path.join(__dirname, '../../prisma/schema.prisma');

const REVIEW_QUEUE_TYPES = [
  'review_queue_bursts',
  'review_queue_duplicates',
  'review_queue_location_suggestions',
  'review_queue_enhancements',
] as const;

const EVENT_TYPES = [
  'upload_completed',
  'enrichment_failed',
  'workflow_run_completed',
  'share_expiring',
] as const;

const ALL_ENUM_VALUES = [...REVIEW_QUEUE_TYPES, ...EVENT_TYPES];

function readMigrationSql(): string {
  return fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
}

function readSchemaPrisma(): string {
  return fs.readFileSync(SCHEMA_PRISMA_PATH, 'utf8');
}

/**
 * Extracts the CREATE [UNIQUE] INDEX statement for the given index name,
 * returning its raw column-list text and WHERE-clause text separately.
 * Deliberately regex-based (not a SQL parser) — this is a drift guard, not
 * a SQL engine, and the migration file is hand-authored raw SQL we control.
 */
function extractPartialIndex(sql: string, indexName: string) {
  const statementRegex = new RegExp(
    `CREATE\\s+(UNIQUE\\s+)?INDEX\\s+"${indexName}"\\s+ON\\s+"([^"]+)"\\s*\\(([^)]*)\\)\\s*WHERE([\\s\\S]*?);`,
    'i',
  );
  const match = sql.match(statementRegex);
  return {
    match,
    isUnique: !!match?.[1],
    tableName: match?.[2] ?? null,
    columnListRaw: match?.[3] ?? null,
    whereClauseRaw: match?.[4] ?? null,
  };
}

function parseQuotedIdentifierList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
    .filter((s) => s.length > 0);
}

function extractEnumValues(sql: string, enumName: string): string[] {
  const enumRegex = new RegExp(
    `CREATE\\s+TYPE\\s+"${enumName}"\\s+AS\\s+ENUM\\s*\\(([\\s\\S]*?)\\)\\s*;`,
    'i',
  );
  const match = sql.match(enumRegex);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''))
    .filter((s) => s.length > 0);
}

describe('Notification Center — migration schema-drift guard (issue #244)', () => {
  const sql = readMigrationSql();

  const index = extractPartialIndex(
    sql,
    'notifications_review_queue_live_uniq_idx',
  );

  describe('notifications_review_queue_live_uniq_idx', () => {
    it('exists as a UNIQUE index on the notifications table', () => {
      expect(index.match).not.toBeNull();
      expect(index.isUnique).toBe(true);
      expect(index.tableName).toBe('notifications');
    });

    it('is scoped to exactly the columns (user_id, circle_id, type)', () => {
      expect(index.columnListRaw).not.toBeNull();
      const columns = parseQuotedIdentifierList(index.columnListRaw as string);
      expect(columns).toEqual(['user_id', 'circle_id', 'type']);
    });

    it('predicate requires dismissed_at IS NULL and circle_id IS NOT NULL', () => {
      expect(index.whereClauseRaw).not.toBeNull();
      const whereClause = index.whereClauseRaw as string;
      expect(whereClause).toContain('"dismissed_at" IS NULL');
      expect(whereClause).toContain('"circle_id" IS NOT NULL');
    });

    it('predicate type IN-list contains exactly the four review_queue_* values', () => {
      const whereClause = index.whereClauseRaw as string;
      const inListMatch = whereClause.match(/"type"\s+IN\s*\(([\s\S]*?)\)/i);
      expect(inListMatch).not.toBeNull();
      const inListValues = (inListMatch![1] as string)
        .split(',')
        .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''))
        .filter((s) => s.length > 0);

      // Exactly the four review_queue_* values, no more, no fewer, and
      // (redundantly, per requirement) none of the four event values.
      expect(new Set(inListValues)).toEqual(new Set(REVIEW_QUEUE_TYPES));
      expect(inListValues).toHaveLength(REVIEW_QUEUE_TYPES.length);
      for (const eventType of EVENT_TYPES) {
        expect(inListValues).not.toContain(eventType);
      }
    });

    it('predicate never mentions any of the four EVENT type literals anywhere', () => {
      // Belt-and-suspenders: even outside the IN-list, an event type literal
      // must never appear in this predicate — that would be exactly the kind
      // of "widen the predicate to cover event types" regression this guard
      // exists to catch, however it were phrased in SQL.
      const whereClause = index.whereClauseRaw as string;
      for (const eventType of EVENT_TYPES) {
        expect(whereClause).not.toContain(`'${eventType}'`);
      }
    });
  });

  describe('NotificationType enum (migration)', () => {
    it('declares exactly the eight expected values', () => {
      const enumValues = extractEnumValues(sql, 'NotificationType');
      expect(new Set(enumValues)).toEqual(new Set(ALL_ENUM_VALUES));
      expect(enumValues).toHaveLength(ALL_ENUM_VALUES.length);
    });
  });

  describe('Notification model (schema.prisma) — documented indexes', () => {
    const schema = readSchemaPrisma();
    const modelMatch = schema.match(
      /model\s+Notification\s*\{([\s\S]*?)\n\}/,
    );

    it('model block is present', () => {
      expect(modelMatch).not.toBeNull();
    });

    it('keeps exactly the five documented @@index declarations', () => {
      const modelBody = modelMatch![1] as string;
      const indexLines = Array.from(
        modelBody.matchAll(/@@index\(\[([^\]]*)\]\)/g),
      ).map((m) => m[1].replace(/\s+/g, ' ').trim());

      const expectedIndexes = [
        'userId, readAt',
        'userId, createdAt(sort: Desc)',
        'userId, dismissedAt',
        'dismissedAt, updatedAt',
        'readAt',
      ];

      expect(indexLines).toHaveLength(expectedIndexes.length);
      expect(new Set(indexLines)).toEqual(new Set(expectedIndexes));
    });

    it('does NOT declare the partial unique index in Prisma DSL (it is raw-SQL-only)', () => {
      const modelBody = modelMatch![1] as string;
      // Sanity check on the documented "not representable in Prisma's schema
      // DSL" precedent: there should be no @@unique in the model body that
      // could silently duplicate/conflict with the raw-SQL partial index.
      expect(modelBody).not.toMatch(/@@unique/);
    });
  });
});
