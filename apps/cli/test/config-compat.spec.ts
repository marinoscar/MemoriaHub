import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyEnvCompat,
  mergeAfterPlatformLogin,
  migrateLegacyConfig,
  snapshotAppFields,
} from '../src/extensions/config-compat.js';
import { fromFileShape, toFileShape } from '../src/config.js';

// A config exactly as 1.3.4 wrote it, with invented values.
const CONFIG_1_3_4 = {
  serverUrl: 'https://mh.example.test',
  pat: 'pat_exampleexampleexample',
  patExpiresAt: '2027-01-01T00:00:00.000Z',
  activeCircleId: '11111111-1111-1111-1111-111111111111',
  nodeId: '22222222-2222-2222-2222-222222222222',
  node: { concurrency: 3, eligibleTypes: ['geocode'], faceProvider: 'compreface', comprefaceUrl: 'http://localhost:3000' },
};

let dir: string;
const file = () => path.join(dir, 'config.json');
const read = () => JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cfg-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('migrateLegacyConfig', () => {
  it('renames pat/patExpiresAt, keeps every other field, backs up once, mode 0600', () => {
    fs.writeFileSync(file(), JSON.stringify(CONFIG_1_3_4), { mode: 0o644 });
    expect(migrateLegacyConfig(dir)).toBe('migrated');
    const out = read();
    expect(out).toEqual({
      serverUrl: CONFIG_1_3_4.serverUrl,
      token: CONFIG_1_3_4.pat,
      expiresAt: CONFIG_1_3_4.patExpiresAt,
      activeCircleId: CONFIG_1_3_4.activeCircleId,
      nodeId: CONFIG_1_3_4.nodeId,
      node: CONFIG_1_3_4.node,
    });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(`${file()}.bak`, 'utf8'))).toEqual(CONFIG_1_3_4);
    expect(fs.statSync(`${file()}.bak`).mode & 0o777).toBe(0o600);
  });

  it('is idempotent and never overwrites the first backup', () => {
    fs.writeFileSync(file(), JSON.stringify(CONFIG_1_3_4));
    migrateLegacyConfig(dir);
    expect(migrateLegacyConfig(dir)).toBe('unchanged');
    expect(JSON.parse(fs.readFileSync(`${file()}.bak`, 'utf8'))).toEqual(CONFIG_1_3_4);
  });

  it('reports absent and tolerates garbage', () => {
    expect(migrateLegacyConfig(dir)).toBe('absent');
    fs.writeFileSync(file(), '{not json');
    expect(migrateLegacyConfig(dir)).toBe('unchanged');
  });

  it('does not fail on an unwritable directory', () => {
    fs.writeFileSync(file(), JSON.stringify(CONFIG_1_3_4));
    fs.chmodSync(dir, 0o500);
    const result = migrateLegacyConfig(dir);
    fs.chmodSync(dir, 0o700);
    expect(['failed', 'migrated']).toContain(result); // root can write anyway
  });
});

describe('config file shape (src/config.ts)', () => {
  it('reads both the legacy and the platform spelling', () => {
    expect(fromFileShape(CONFIG_1_3_4).pat).toBe(CONFIG_1_3_4.pat);
    const platform = fromFileShape({ serverUrl: 'https://x.example.test', token: 'pat_t', expiresAt: '2027-02-02T00:00:00.000Z' });
    expect(platform).toMatchObject({ pat: 'pat_t', patExpiresAt: '2027-02-02T00:00:00.000Z' });
  });

  it('writes the platform names and keeps foreign keys', () => {
    const out = toFileShape(
      { serverUrl: 'https://x.example.test', pat: 'pat_n', activeCircleId: 'c' },
      { pat: 'old', tokenId: 'tid', tokenName: 'laptop', expiresAt: 'stale' },
    );
    expect(out).toEqual({ serverUrl: 'https://x.example.test', token: 'pat_n', activeCircleId: 'c', tokenId: 'tid', tokenName: 'laptop' });
  });
});

describe('platform login round trip', () => {
  it('puts the app-only fields back after the platform rewrote the file', () => {
    fs.writeFileSync(file(), JSON.stringify(CONFIG_1_3_4));
    migrateLegacyConfig(dir);
    const appFields = snapshotAppFields(dir);
    expect(appFields).toEqual({ activeCircleId: CONFIG_1_3_4.activeCircleId, nodeId: CONFIG_1_3_4.nodeId, node: CONFIG_1_3_4.node });
    // The platform's login replaces the file with only its own fields.
    fs.writeFileSync(file(), JSON.stringify({ serverUrl: 'https://new.example.test', token: 'pat_new', tokenId: 't1', updatedAt: 'now' }));
    expect(mergeAfterPlatformLogin(appFields, dir, dir)).toBe('migrated');
    expect(read()).toMatchObject({ serverUrl: 'https://new.example.test', token: 'pat_new', activeCircleId: CONFIG_1_3_4.activeCircleId, node: CONFIG_1_3_4.node });
    expect(read()).not.toHaveProperty('expiresAt');
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('copies credentials into the state directory when the platform wrote elsewhere', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-home-'));
    fs.writeFileSync(path.join(other, 'config.json'), JSON.stringify({ serverUrl: 'https://p.example.test', token: 'pat_p' }));
    mergeAfterPlatformLogin({ activeCircleId: 'c' }, other, dir);
    expect(read()).toEqual({ activeCircleId: 'c', serverUrl: 'https://p.example.test', token: 'pat_p' });
    fs.rmSync(other, { recursive: true, force: true });
  });
});

describe('applyEnvCompat', () => {
  it('mirrors MEMORIAHUB_URL onto MEMORIAHUB_SERVER_URL', () => {
    expect(applyEnvCompat({ MEMORIAHUB_URL: 'https://w.example.test', MEMORIAHUB_TOKEN: 'nod_x' })).toEqual({ MEMORIAHUB_SERVER_URL: 'https://w.example.test' });
  });
  it('never overrides an explicit MEMORIAHUB_SERVER_URL', () => {
    expect(applyEnvCompat({ MEMORIAHUB_URL: 'a', MEMORIAHUB_SERVER_URL: 'b' })).toEqual({});
  });
  it('handles a worker container env (docs/worker-container-config.md names)', () => {
    const env = { MEMORIAHUB_URL: 'https://w.example.test', MEMORIAHUB_TOKEN: 'nod_x', MEMORIAHUB_HEADLESS: '1', MEMORIAHUB_STATE_DIR: '/state', MEMORIAHUB_CONCURRENCY: '4' };
    expect(applyEnvCompat(env)).toEqual({ MEMORIAHUB_SERVER_URL: 'https://w.example.test' });
  });
});
