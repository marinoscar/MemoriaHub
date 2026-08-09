// Schema/migration-drift guard for the Memories data-model foundation
// (issue #301, epic #300).
//
// WHY THIS TEST EXISTS AND WHAT IT DOES NOT DO: this repo's CI has no live
// Postgres (see docs/ci-known-failing-tests.md — apps/api integration specs
// boot the AppModule over a MOCKED Prisma). This suite reads schema.prisma
// and the add_memories migration SQL straight off disk with plain
// string/regex parsing (no DB, no Prisma client, no NestJS module) — the
// same technique used by test/notifications/notification-schema-guard.spec.ts
// — and asserts the exact shape the issue #301 acceptance criteria and
// docs/specs/memories.md §2 depend on:
//
//   - The MemoryType enum has exactly the seven documented values.
//   - Memory/MemoryItem/MemoryUserState declare the documented fields,
//     @map names, onDelete behaviors, and indexes/unique constraints.
//   - subjectKey is `String @default("")`, never nullable — the whole
//     tombstone-and-dedup contract in docs/specs/memories.md §2.1/§2.5
//     depends on this; a nullable subjectKey would silently defeat the
//     @@unique index for the seasonal/year_in_review types.
//   - The @@unique([circleId, type, periodKey, subjectKey]) index exists
//     with no WHERE predicate — i.e. it spans BOTH live and tombstoned
//     (deletedAt IS NOT NULL) rows, which is what makes the tombstone
//     effective (see docs/specs/memories.md §2.5). This is verified
//     against the migration SQL, not just schema.prisma, since a
//     Prisma-level @@unique with no predicate always compiles to a plain
//     (non-partial) SQL unique index — this test pins that fact so a
//     future refactor can't accidentally narrow it to a partial index.
//   - The back-reference relations on Circle/Person/MediaItem/User exist,
//     including the two DISTINCT MediaItem relations (memoryItems vs. the
//     named "MemoryCover" cover back-ref) the issue explicitly called for.
//
// Real-database behaviors (the P2002 unique-constraint conflict, the
// tombstone actually blocking recreation, cascade/set-null deletes) are
// covered by the DB_GATED companion suite,
// test/memories/memories.integration.spec.ts, which this suite deliberately
// does not attempt (jest-mock-extended never touches a real constraint).

import * as fs from 'fs';
import * as path from 'path';

const SCHEMA_PRISMA_PATH = path.join(__dirname, '../../prisma/schema.prisma');
const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '../../prisma/migrations/20260809130452_add_memories/migration.sql',
);

const EXPECTED_MEMORY_TYPES = [
  'on_this_day',
  'trip',
  'person_highlights',
  'person_over_years',
  'theme',
  'seasonal',
  'year_in_review',
] as const;

function readSchemaPrisma(): string {
  return fs.readFileSync(SCHEMA_PRISMA_PATH, 'utf8');
}

function readMigrationSql(): string {
  return fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
}

/** Extracts a top-level `model <Name> { ... }` or `enum <Name> { ... }` body. */
function extractBlock(source: string, kind: 'model' | 'enum', name: string): string {
  const regex = new RegExp(`${kind}\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm');
  const match = source.match(regex);
  if (!match) {
    throw new Error(`Could not find ${kind} ${name} in schema.prisma`);
  }
  return match[1];
}

function extractEnumValuesFromSchema(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line) => line.split(/\s|\/\//)[0].trim())
    .filter((token) => token.length > 0);
}

function extractEnumValuesFromMigration(sql: string, enumName: string): string[] {
  const regex = new RegExp(`CREATE\\s+TYPE\\s+"${enumName}"\\s+AS\\s+ENUM\\s*\\(([\\s\\S]*?)\\)\\s*;`, 'i');
  const match = sql.match(regex);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''))
    .filter((s) => s.length > 0);
}

describe('Memories — data model schema-drift guard (issue #301)', () => {
  const schema = readSchemaPrisma();
  const migrationSql = readMigrationSql();

  describe('MemoryType enum', () => {
    it('declares exactly the seven documented values, in schema.prisma', () => {
      const body = extractBlock(schema, 'enum', 'MemoryType');
      const values = extractEnumValuesFromSchema(body);
      expect(new Set(values)).toEqual(new Set(EXPECTED_MEMORY_TYPES));
      expect(values).toHaveLength(EXPECTED_MEMORY_TYPES.length);
    });

    it('declares exactly the seven documented values, in the migration SQL', () => {
      const values = extractEnumValuesFromMigration(migrationSql, 'MemoryType');
      expect(new Set(values)).toEqual(new Set(EXPECTED_MEMORY_TYPES));
      expect(values).toHaveLength(EXPECTED_MEMORY_TYPES.length);
    });
  });

  describe('Memory model', () => {
    const body = extractBlock(schema, 'model', 'Memory');

    it('declares subjectKey as a non-nullable String defaulting to "" (never NULL)', () => {
      expect(body).toMatch(/subjectKey\s+String\s+@default\(""\)\s+@map\("subject_key"\)/);
      // Belt-and-suspenders: subjectKey must never appear with a `?` nullable marker.
      expect(body).not.toMatch(/subjectKey\s+String\?/);
    });

    it('declares periodKey as a required (non-nullable) String', () => {
      expect(body).toMatch(/periodKey\s+String\s+@map\("period_key"\)/);
    });

    it('declares personId as nullable, FK to Person with onDelete: Cascade', () => {
      expect(body).toMatch(/personId\s+String\?\s+@map\("person_id"\)\s+@db\.Uuid/);
      expect(body).toMatch(/person\s+Person\?\s+@relation\(fields:\s*\[personId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
    });

    it('declares coverMediaItemId as nullable, FK to MediaItem with onDelete: SetNull, via a named "MemoryCover" relation', () => {
      expect(body).toMatch(/coverMediaItemId\s+String\?\s+@map\("cover_media_item_id"\)\s+@db\.Uuid/);
      expect(body).toMatch(
        /coverMediaItem\s+MediaItem\?\s+@relation\("MemoryCover",\s*fields:\s*\[coverMediaItemId\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/,
      );
    });

    it('declares circle as a required FK to Circle with onDelete: Cascade', () => {
      expect(body).toMatch(/circleId\s+String\s+@map\("circle_id"\)\s+@db\.Uuid/);
      expect(body).toMatch(/circle\s+Circle\s+@relation\(fields:\s*\[circleId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
    });

    it('declares titleSource (String, not an enum) and titleModel (String?)', () => {
      expect(body).toMatch(/titleSource\s+String\s+@map\("title_source"\)/);
      expect(body).toMatch(/titleModel\s+String\?\s+@map\("title_model"\)/);
    });

    it('declares periodStart/periodEnd as required Timestamptz DateTime columns', () => {
      expect(body).toMatch(/periodStart\s+DateTime\s+@map\("period_start"\)\s+@db\.Timestamptz/);
      expect(body).toMatch(/periodEnd\s+DateTime\s+@map\("period_end"\)\s+@db\.Timestamptz/);
    });

    it('declares itemCount as a required Int', () => {
      expect(body).toMatch(/itemCount\s+Int\s+@map\("item_count"\)/);
    });

    it('declares meta as an optional Json column', () => {
      expect(body).toMatch(/meta\s+Json\?\s+@db\.JsonB/);
    });

    it('declares generatedAt/refreshedAt as required, expiresAt/deletedAt as optional', () => {
      expect(body).toMatch(/generatedAt\s+DateTime\s+@map\("generated_at"\)\s+@db\.Timestamptz/);
      expect(body).toMatch(/refreshedAt\s+DateTime\s+@map\("refreshed_at"\)\s+@db\.Timestamptz/);
      expect(body).toMatch(/expiresAt\s+DateTime\?\s+@map\("expires_at"\)\s+@db\.Timestamptz/);
      expect(body).toMatch(/deletedAt\s+DateTime\?\s+@map\("deleted_at"\)\s+@db\.Timestamptz/);
    });

    it('has createdAt/updatedAt with the standard defaults', () => {
      expect(body).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)\s+@map\("created_at"\)\s+@db\.Timestamptz/);
      expect(body).toMatch(/updatedAt\s+DateTime\s+@updatedAt\s+@map\("updated_at"\)\s+@db\.Timestamptz/);
    });

    it('declares the idempotent-regeneration unique key on (circleId, type, periodKey, subjectKey)', () => {
      expect(body).toMatch(/@@unique\(\[circleId,\s*type,\s*periodKey,\s*subjectKey\]\)/);
    });

    it('declares exactly the four documented @@index directives (in addition to the @@unique above)', () => {
      const indexLines = Array.from(body.matchAll(/@@index\(\[([^\]]*)\]\)/g)).map((m) =>
        m[1].replace(/\s+/g, ' ').trim(),
      );
      const expectedIndexes = [
        'circleId, deletedAt, expiresAt, generatedAt(sort: Desc)',
        'circleId, type',
        'personId',
        'coverMediaItemId',
      ];
      expect(indexLines).toHaveLength(expectedIndexes.length);
      expect(new Set(indexLines)).toEqual(new Set(expectedIndexes));
    });

    it('maps to the memories table', () => {
      expect(body).toMatch(/@@map\("memories"\)/);
    });
  });

  describe('MemoryItem model', () => {
    const body = extractBlock(schema, 'model', 'MemoryItem');

    it('declares position as a required Int and score as an optional Float', () => {
      expect(body).toMatch(/position\s+Int\b/);
      expect(body).toMatch(/score\s+Float\?/);
    });

    it('declares memory and mediaItem as required FKs with onDelete: Cascade', () => {
      expect(body).toMatch(/memory\s+Memory\s+@relation\(fields:\s*\[memoryId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
      expect(body).toMatch(/mediaItem\s+MediaItem\s+@relation\(fields:\s*\[mediaItemId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
    });

    it('declares @@unique([memoryId, mediaItemId]) and both documented indexes', () => {
      expect(body).toMatch(/@@unique\(\[memoryId,\s*mediaItemId\]\)/);
      expect(body).toMatch(/@@index\(\[memoryId,\s*position\]\)/);
      expect(body).toMatch(/@@index\(\[mediaItemId\]\)/);
    });

    it('maps to the memory_items table', () => {
      expect(body).toMatch(/@@map\("memory_items"\)/);
    });
  });

  describe('MemoryUserState model', () => {
    const body = extractBlock(schema, 'model', 'MemoryUserState');

    it('declares seenAt/hiddenAt/favoritedAt as optional Timestamptz columns', () => {
      expect(body).toMatch(/seenAt\s+DateTime\?\s+@map\("seen_at"\)\s+@db\.Timestamptz/);
      expect(body).toMatch(/hiddenAt\s+DateTime\?\s+@map\("hidden_at"\)\s+@db\.Timestamptz/);
      expect(body).toMatch(/favoritedAt\s+DateTime\?\s+@map\("favorited_at"\)\s+@db\.Timestamptz/);
    });

    it('declares memory and user as required FKs with onDelete: Cascade', () => {
      expect(body).toMatch(/memory\s+Memory\s+@relation\(fields:\s*\[memoryId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
      expect(body).toMatch(/user\s+User\s+@relation\(fields:\s*\[userId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
    });

    it('declares @@unique([memoryId, userId]) and the documented index', () => {
      expect(body).toMatch(/@@unique\(\[memoryId,\s*userId\]\)/);
      expect(body).toMatch(/@@index\(\[userId,\s*favoritedAt\]\)/);
    });

    it('maps to the memory_user_state table', () => {
      expect(body).toMatch(/@@map\("memory_user_state"\)/);
    });
  });

  describe('back-reference relations on existing models', () => {
    it('Circle declares a memories Memory[] relation', () => {
      const body = extractBlock(schema, 'model', 'Circle');
      expect(body).toMatch(/memories\s+Memory\[\]/);
    });

    it('Person declares a memories Memory[] relation', () => {
      const body = extractBlock(schema, 'model', 'Person');
      expect(body).toMatch(/memories\s+Memory\[\]/);
    });

    it('User declares a memoryUserStates MemoryUserState[] relation', () => {
      const body = extractBlock(schema, 'model', 'User');
      expect(body).toMatch(/memoryUserStates\s+MemoryUserState\[\]/);
    });

    it('MediaItem declares TWO distinct relations: memoryItems MemoryItem[] and a named "MemoryCover" back-ref', () => {
      const body = extractBlock(schema, 'model', 'MediaItem');
      expect(body).toMatch(/memoryItems\s+MemoryItem\[\]/);
      expect(body).toMatch(/coverForMemories\s+Memory\[\]\s+@relation\("MemoryCover"\)/);
    });
  });

  describe('add_memories migration SQL', () => {
    it('creates the @@unique([circleId, type, periodKey, subjectKey]) index with NO WHERE predicate (spans live + tombstoned rows)', () => {
      // Must exist as a plain (non-partial) unique index — i.e. the CREATE
      // UNIQUE INDEX statement's own line has no WHERE clause. This is what
      // makes the tombstone contract (docs/specs/memories.md §2.5) work: a
      // deleted (deletedAt IS NOT NULL) row still occupies the dedup slot.
      const statementRegex =
        /CREATE UNIQUE INDEX "memories_circle_id_type_period_key_subject_key_key" ON "memories"\("circle_id", "type", "period_key", "subject_key"\);/;
      expect(migrationSql).toMatch(statementRegex);
    });

    it('creates memories/memory_items/memory_user_state tables and their foreign keys', () => {
      expect(migrationSql).toMatch(/CREATE TABLE "memories"/);
      expect(migrationSql).toMatch(/CREATE TABLE "memory_items"/);
      expect(migrationSql).toMatch(/CREATE TABLE "memory_user_state"/);

      expect(migrationSql).toMatch(
        /ALTER TABLE "memories" ADD CONSTRAINT "memories_circle_id_fkey" FOREIGN KEY \("circle_id"\) REFERENCES "circles"\("id"\) ON DELETE CASCADE/,
      );
      expect(migrationSql).toMatch(
        /ALTER TABLE "memories" ADD CONSTRAINT "memories_person_id_fkey" FOREIGN KEY \("person_id"\) REFERENCES "people"\("id"\) ON DELETE CASCADE/,
      );
      expect(migrationSql).toMatch(
        /ALTER TABLE "memories" ADD CONSTRAINT "memories_cover_media_item_id_fkey" FOREIGN KEY \("cover_media_item_id"\) REFERENCES "media_items"\("id"\) ON DELETE SET NULL/,
      );
      expect(migrationSql).toMatch(
        /ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_memory_id_fkey" FOREIGN KEY \("memory_id"\) REFERENCES "memories"\("id"\) ON DELETE CASCADE/,
      );
      expect(migrationSql).toMatch(
        /ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_media_item_id_fkey" FOREIGN KEY \("media_item_id"\) REFERENCES "media_items"\("id"\) ON DELETE CASCADE/,
      );
      expect(migrationSql).toMatch(
        /ALTER TABLE "memory_user_state" ADD CONSTRAINT "memory_user_state_memory_id_fkey" FOREIGN KEY \("memory_id"\) REFERENCES "memories"\("id"\) ON DELETE CASCADE/,
      );
      expect(migrationSql).toMatch(
        /ALTER TABLE "memory_user_state" ADD CONSTRAINT "memory_user_state_user_id_fkey" FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\) ON DELETE CASCADE/,
      );
    });

    it('declares subject_key as TEXT NOT NULL DEFAULT \'\' (never nullable)', () => {
      expect(migrationSql).toMatch(/"subject_key" TEXT NOT NULL DEFAULT ''/);
    });

    it('does NOT drop or alter any table/index outside the memories/memory_items/memory_user_state feature', () => {
      // Regression guard for the exact defect this migration file was
      // hand-pruned to fix: `prisma migrate dev`'s raw diff also proposed
      // dropping the media_visual_embedding table and the faces/
      // media_item_embedding HNSW indexes (pre-existing raw-SQL-only schema
      // objects not representable in schema.prisma — see CLAUDE.md's
      // Database Tables section) plus renaming several long-standing FK
      // constraints. None of that belongs in this migration.
      expect(migrationSql).not.toMatch(/DROP TABLE/i);
      expect(migrationSql).not.toMatch(/DROP INDEX/i);
      expect(migrationSql).not.toMatch(/DROP CONSTRAINT/i);
      expect(migrationSql).not.toMatch(/RENAME CONSTRAINT/i);
      expect(migrationSql).not.toMatch(/DROP DEFAULT/i);
    });
  });
});
