import { describe, expect, it } from 'vitest';

import { checkDatabaseCatalog, checkMemoriahubInstall, readInventories, type DatabaseCatalog } from '../src/index.js';
import { PACKAGE_DIR, cleanup, freshHost } from './helpers.js';
import { afterEach } from 'vitest';

afterEach(cleanup);

const inventories = readInventories(PACKAGE_DIR);

/** A catalog that has every object the inventories ask for. */
function completeCatalog(): DatabaseCatalog {
  return {
    extensions: [{ name: 'vector', version: '0.6.0' }],
    indexes: inventories.rawSqlIndexes.map((index) => ({ name: index.name, table: index.table })),
    triggers: inventories.schemaObjects.triggers.map((t) => ({ name: t.name, table: t.table })),
    functions: inventories.schemaObjects.functions.map((f) => f.name),
    constraints: inventories.schemaObjects.checkConstraints,
    generatedColumns: inventories.schemaObjects.generatedColumns,
  };
}

describe('checkDatabaseCatalog', () => {
  it('accepts a complete catalog', () => {
    expect(checkDatabaseCatalog(completeCatalog(), inventories)).toEqual([]);
  });

  it('reports a missing extension with the statement a superuser must run', () => {
    const catalog = { ...completeCatalog(), extensions: [] };
    const problems = checkDatabaseCatalog(catalog, inventories);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('EXTENSION_MISSING');
    expect(problems[0]?.message).toContain('CREATE EXTENSION IF NOT EXISTS vector;');
  });

  it('reports an extension older than minVersion', () => {
    const catalog = { ...completeCatalog(), extensions: [{ name: 'vector', version: '0.4.4' }] };
    expect(checkDatabaseCatalog(catalog, inventories).map((p) => p.code)).toEqual(['EXTENSION_TOO_OLD']);
    const exact = { ...completeCatalog(), extensions: [{ name: 'vector', version: '0.5.0' }] };
    expect(checkDatabaseCatalog(exact, inventories)).toEqual([]);
  });

  it('reports a dropped raw index, trigger, function and CHECK constraint', () => {
    const catalog = completeCatalog();
    catalog.indexes = catalog.indexes.filter((i) => i.name !== 'faces_embedding_vec_hnsw_idx');
    catalog.triggers = catalog.triggers.filter((t) => t.name !== 'faces_sync_embedding_vec_insert_trigger');
    catalog.functions = [];
    catalog.constraints = catalog.constraints.filter((c) => c.name !== 'albums_one_owner_check');
    expect([...new Set(checkDatabaseCatalog(catalog, inventories).map((p) => p.code))]).toEqual(['INDEX_MISSING', 'CONSTRAINT_MISSING', 'FUNCTION_MISSING', 'TRIGGER_MISSING']);
  });

  it('is wired into checkMemoriahubInstall with an injected catalog', async () => {
    const root = freshHost();
    const { applyMemoriahubSync, planMemoriahubSync } = await import('../src/index.js');
    applyMemoriahubSync(planMemoriahubSync({ root, platformSchemaDir: null }));
    const ok = await checkMemoriahubInstall({ root, database: true, catalog: completeCatalog() });
    expect(ok.ok).toBe(true);
    const broken = completeCatalog();
    broken.indexes = broken.indexes.slice(1);
    expect((await checkMemoriahubInstall({ root, database: true, catalog: broken })).problems.map((p) => p.code)).toEqual(['INDEX_MISSING']);
  });
});
