/**
 * test/backup/init-backup.spec.ts — `backup init` engine, end-to-end against a
 * mocked ApiClient + in-memory settings store.
 *
 * Covers: node registration only when no nodeId is configured, the config PUT
 * ({ config } top-level envelope), on-disk skeleton + catalog creation with
 * seeded meta, idempotent re-run against the same root (catalog preserved,
 * created_at unmoved), and the hard refusal of a second root.
 */

import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runBackupInit,
  BackupRootConflictError,
  type BackupSettingsStore,
} from '../../src/backup/init-backup.js';
import { openCatalogDb } from '../../src/backup/catalog-db.js';
import { CatalogRepo } from '../../src/backup/catalog-repo.js';
import { absPathFor, CATALOG_DB_REL_PATH } from '../../src/backup/layout.js';
import type { NodeBackupConfigResult, UpdateNodeBackupConfigBody } from '../../src/api.js';

function makeSettings(): BackupSettingsStore & { rootValue: string | null; nodeIdValue: string | null } {
  const store = {
    rootValue: null as string | null,
    nodeIdValue: null as string | null,
    backupRoot: (): string | null => store.rootValue,
    setBackupRoot: (root: string): void => {
      store.rootValue = root;
    },
    backupNodeId: (): string | null => store.nodeIdValue,
    setBackupNodeId: (nodeId: string): void => {
      store.nodeIdValue = nodeId;
    },
  };
  return store;
}

function makeApi(): {
  putNodeBackupConfig: jest.Mock<
    (nodeId: string, body: UpdateNodeBackupConfigBody) => Promise<NodeBackupConfigResult>
  >;
} {
  return {
    putNodeBackupConfig: jest.fn(
      async (nodeId: string, body: UpdateNodeBackupConfigBody): Promise<NodeBackupConfigResult> => ({
        config: {
          nodeId,
          enabled: body.enabled ?? true,
          scheduleCron: null,
          timezone: null,
          circleIds: body.circleIds ?? [],
        },
      }),
    ),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-init-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runBackupInit', () => {
  it('registers a node when none is configured, PUTs config, creates skeleton + catalog', async () => {
    const settings = makeSettings();
    const api = makeApi();
    const registerNode = jest.fn(async (_name: string) => ({
      nodeId: 'node-123',
      reattached: false,
    }));

    const root = path.join(tmpDir, 'backups');
    const result = await runBackupInit(
      {
        destDir: root,
        existingNodeId: null,
        nodeName: 'backup-testhost',
        circleIds: ['circle-a', 'circle-b'],
        serverUrl: 'https://hub.example',
      },
      {
        api,
        registerNode,
        settings,
        now: () => new Date('2026-08-08T00:00:00.000Z'),
      },
    );

    // Node registration happened exactly once, with the requested name.
    expect(registerNode).toHaveBeenCalledTimes(1);
    expect(registerNode).toHaveBeenCalledWith('backup-testhost');

    // Server-side config enabled with the circle scope.
    expect(api.putNodeBackupConfig).toHaveBeenCalledWith('node-123', {
      enabled: true,
      circleIds: ['circle-a', 'circle-b'],
    });

    expect(result).toMatchObject({
      root,
      nodeId: 'node-123',
      registeredNode: true,
      reattached: false,
      reinitialized: false,
    });
    expect(result.config.circleIds).toEqual(['circle-a', 'circle-b']);

    // On-disk skeleton + catalog.
    for (const rel of ['media', 'archived', '_quarantine', 'catalog', '.memoriahub/tmp']) {
      expect(fs.statSync(absPathFor(root, rel)).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(absPathFor(root, CATALOG_DB_REL_PATH))).toBe(true);

    // Meta seeded.
    const db = openCatalogDb(root);
    const repo = new CatalogRepo(db);
    expect(repo.getMeta('server_url')).toBe('https://hub.example');
    expect(repo.getMeta('node_id')).toBe('node-123');
    expect(repo.getMeta('node_name')).toBe('backup-testhost');
    expect(repo.getMeta('created_at')).toBe('2026-08-08T00:00:00.000Z');
    expect(repo.getMeta('schema_note')).toContain('SQLite');
    db.close();

    // Central binding persisted.
    expect(settings.rootValue).toBe(root);
    expect(settings.nodeIdValue).toBe('node-123');
  });

  it('skips registration when a nodeId is already configured', async () => {
    const settings = makeSettings();
    const api = makeApi();
    const registerNode = jest.fn(async () => ({ nodeId: 'never', reattached: false }));

    const result = await runBackupInit(
      {
        destDir: path.join(tmpDir, 'root'),
        existingNodeId: 'node-existing',
        nodeName: 'n',
        circleIds: [],
        serverUrl: 'https://hub.example',
      },
      { api, registerNode, settings },
    );

    expect(registerNode).not.toHaveBeenCalled();
    expect(result.nodeId).toBe('node-existing');
    expect(result.registeredNode).toBe(false);
    expect(api.putNodeBackupConfig).toHaveBeenCalledWith('node-existing', {
      enabled: true,
      circleIds: [],
    });
  });

  it('re-running against the same root is idempotent and preserves the catalog', async () => {
    const settings = makeSettings();
    const api = makeApi();
    const registerNode = jest.fn(async () => ({ nodeId: 'node-1', reattached: false }));
    const root = path.join(tmpDir, 'root');

    const input = {
      destDir: root,
      existingNodeId: null as string | null,
      nodeName: 'n',
      circleIds: [] as string[],
      serverUrl: 'https://hub.example',
    };

    await runBackupInit(input, {
      api,
      registerNode,
      settings,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    // Seed catalog content that a re-run must NOT destroy.
    {
      const db = openCatalogDb(root);
      new CatalogRepo(db).upsertItemWithDims(
        {
          mediaItemId: 'item-1',
          circleId: 'c',
          relPath: 'media/2024/03/a.jpg',
          sidecarRelPath: 'media/2024/03/a.jpg.json',
          capturedAt: null,
          contentHash: null,
          size: 1,
          mimeType: null,
          serverUpdatedAt: 'x',
          status: 'present',
          archived: false,
          downloadedAt: null,
          verifiedAt: null,
          lastError: null,
        },
        {},
      );
      db.close();
    }

    const second = await runBackupInit(
      { ...input, existingNodeId: 'node-1' },
      { api, registerNode, settings, now: () => new Date('2026-06-06T00:00:00.000Z') },
    );

    expect(second.reinitialized).toBe(true);
    expect(registerNode).toHaveBeenCalledTimes(1); // first run only

    const db = openCatalogDb(root);
    const repo = new CatalogRepo(db);
    // Existing catalog data survived; created_at was NOT moved.
    expect(repo.getById('item-1')).not.toBeNull();
    expect(repo.getMeta('created_at')).toBe('2026-01-01T00:00:00.000Z');
    db.close();
  });

  it('refuses a second, different root with a hard error (nothing touched)', async () => {
    const settings = makeSettings();
    const api = makeApi();
    const registerNode = jest.fn(async () => ({ nodeId: 'node-1', reattached: false }));

    const firstRoot = path.join(tmpDir, 'first');
    await runBackupInit(
      {
        destDir: firstRoot,
        existingNodeId: null,
        nodeName: 'n',
        circleIds: [],
        serverUrl: 'https://hub.example',
      },
      { api, registerNode, settings },
    );

    const secondRoot = path.join(tmpDir, 'second');
    await expect(
      runBackupInit(
        {
          destDir: secondRoot,
          existingNodeId: 'node-1',
          nodeName: 'n',
          circleIds: [],
          serverUrl: 'https://hub.example',
        },
        { api, registerNode, settings },
      ),
    ).rejects.toThrow(BackupRootConflictError);

    // The second root was never created; the binding still points at the first.
    expect(fs.existsSync(secondRoot)).toBe(false);
    expect(settings.rootValue).toBe(firstRoot);
    // The guard fires before any API call for the second root.
    expect(api.putNodeBackupConfig).toHaveBeenCalledTimes(1);
  });

  it('propagates a server error without persisting the local binding', async () => {
    const settings = makeSettings();
    const registerNode = jest.fn(async () => ({ nodeId: 'node-1', reattached: false }));
    const api = {
      putNodeBackupConfig: jest.fn(async (): Promise<NodeBackupConfigResult> => {
        throw new Error('HTTP 403');
      }),
    };

    await expect(
      runBackupInit(
        {
          destDir: path.join(tmpDir, 'root'),
          existingNodeId: 'node-1',
          nodeName: 'n',
          circleIds: [],
          serverUrl: 'https://hub.example',
        },
        { api, registerNode, settings },
      ),
    ).rejects.toThrow('HTTP 403');

    expect(settings.rootValue).toBeNull();
    expect(settings.nodeIdValue).toBeNull();
  });
});
