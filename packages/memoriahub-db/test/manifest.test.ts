import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MEMORIAHUB_EXTENSIONS,
  MEMORIAHUB_HOST_TABLES,
  MEMORIAHUB_RAW_SQL_INDEXES,
  checkPackage,
  listPackageFragments,
  parseManifest,
  readInventories,
  readManifest,
  serializeManifest,
} from '../src/index.js';
import { PACKAGE_DIR } from './helpers.js';

const migrationsDir = join(PACKAGE_DIR, 'migrations');
const manifest = readManifest(migrationsDir);

describe('migrations/manifest.json', () => {
  it('records the sha256 of every migration.sql, comments included', () => {
    for (const entry of manifest.migrations) {
      const bytes = readFileSync(join(migrationsDir, entry.id, 'migration.sql'));
      expect(createHash('sha256').update(bytes).digest('hex'), entry.id).toBe(entry.sha256);
    }
  });

  it('has an entry for every migration directory and a directory for every entry', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(manifest.migrations.map((entry) => entry.id)).toEqual(dirs);
  });

  it('lists the ids in ascending order, each with a known slice and host-table list', () => {
    const ids = manifest.migrations.map((entry) => entry.id);
    expect([...ids].sort()).toEqual(ids);
    const fragments = new Set(listPackageFragments(join(PACKAGE_DIR, 'schema')).map((name) => name.split('.')[1]));
    for (const entry of manifest.migrations) {
      expect(fragments.has(entry.slice), `${entry.id} slice ${entry.slice}`).toBe(true);
      for (const table of entry.requiresHostTables) expect(MEMORIAHUB_HOST_TABLES).toContain(table);
    }
  });

  it('has exactly one baseline, the first migration, adopted by a host that holds the web app history', () => {
    const baselines = manifest.migrations.filter((entry) => entry.baseline !== undefined);
    expect(baselines.map((entry) => entry.id)).toEqual([manifest.migrations[0]!.id]);
    expect(baselines[0]!.baseline).toEqual({ adoptedWhenHostHas: '20260610000000_add_media_domain' });
  });

  it('derives requiresHostTables from the foreign keys in the SQL', () => {
    for (const entry of manifest.migrations) {
      const sql = readFileSync(join(migrationsDir, entry.id, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');
      const referenced = MEMORIAHUB_HOST_TABLES.filter((table) => new RegExp(`REFERENCES\\s+(?:public\\.)?"?${table}"?\\s*\\(`, 'i').test(sql));
      expect([...entry.requiresHostTables].sort(), entry.id).toEqual([...referenced].sort());
    }
  });

  it('is written in the canonical serialisation', () => {
    expect(serializeManifest(manifest)).toBe(readFileSync(join(migrationsDir, 'manifest.json'), 'utf8'));
  });

  it('refuses a malformed manifest', () => {
    expect(() => parseManifest('{"manifestVersion":2,"migrations":[]}')).toThrow(/manifestVersion/);
    expect(() => parseManifest('{"manifestVersion":1,"migrations":[{"id":"x","slice":"a","sha256":"0","requiresHostTables":[]}]}')).toThrow(/id/);
    const entry = { id: '20260101000000_a', slice: 'media', sha256: 'a'.repeat(64), requiresHostTables: ['orders'] };
    expect(() => parseManifest(JSON.stringify({ manifestVersion: 1, migrations: [entry] }))).toThrow(/requiresHostTables/);
  });
});

describe('inventories', () => {
  const inventories = readInventories(PACKAGE_DIR);

  it('exports the inventory files as constants', () => {
    expect(MEMORIAHUB_RAW_SQL_INDEXES).toEqual(inventories.rawSqlIndexes);
    expect(MEMORIAHUB_EXTENSIONS.map((extension) => extension.name)).toEqual(['vector']);
    expect(MEMORIAHUB_EXTENSIONS[0]?.minVersion).toBe('0.5.0');
  });

  it('lists the fifteen special indexes of the domain by name', () => {
    expect(MEMORIAHUB_RAW_SQL_INDEXES.map((index) => index.name).sort()).toEqual(
      [
        'faces_embedding_vec_archive_hnsw_idx',
        'faces_embedding_vec_assigned_hnsw_idx',
        'faces_embedding_vec_hnsw_idx',
        'idx_media_circle_device_captured',
        'media_item_embedding_hnsw_idx',
        'media_items_captured_md_idx',
        'media_items_circle_captured_md_idx',
        'media_items_circle_content_hash_active_key',
        'media_items_gallery_idx',
        'media_items_map_locations_idx',
        'media_visual_embedding_hnsw_idx',
        'people_circle_id_hidden_at_idx',
        'review_run_items_run_id_burst_group_id_key',
        'review_run_items_run_id_duplicate_group_id_key',
        'review_run_items_run_id_location_suggestion_id_key',
      ].sort(),
    );
  });

  it('names the four functions, the 23 triggers (the faces vector sync among them) and the CHECK constraints', () => {
    expect(inventories.schemaObjects.functions.map((fn) => fn.name).sort()).toEqual([
      'face_embedding_to_vector',
      'faces_sync_embedding_vec',
      'mh_content_owner_from_scope',
      'mh_default_org_id',
    ]);
    const triggers = inventories.schemaObjects.triggers.map((t) => t.name);
    expect(triggers).toHaveLength(23);
    expect(triggers).toEqual(expect.arrayContaining(['faces_sync_embedding_vec_insert_trigger', 'faces_sync_embedding_vec_update_trigger']));
    expect(inventories.schemaObjects.checkConstraints.length).toBeGreaterThan(0);
    expect(inventories.schemaObjects.generatedColumns).toEqual([]);
  });

  it('is consistent with the migrations and the fragments (the package check)', () => {
    expect(checkPackage(PACKAGE_DIR)).toEqual([]);
  });
});
