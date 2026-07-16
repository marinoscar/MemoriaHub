/**
 * config-env.spec.ts — Unit tests for the MEMORIAHUB_* env overlay in config.ts.
 *
 * We test:
 *   1. Env-only synthesis: no config file + MEMORIAHUB_URL+MEMORIAHUB_TOKEN → valid config
 *   2. No-file-no-env semantics preserved (loadConfig returns null)
 *   3. Per-field precedence: env wins over file, file-only fields survive
 *   4. CSV parsing of MEMORIAHUB_ELIGIBLE_TYPES (trim, drop empties)
 *   5. Int parsing of MEMORIAHUB_CONCURRENCY / MEMORIAHUB_POLL_INTERVAL_MS
 *      (invalid values ignored with a warning)
 *   6. MEMORIAHUB_FACE_PROVIDER validation ('human' | 'compreface' only)
 *   7. envConfigComplete() helper
 *   8. saveConfig() best-effort persistence when config came from env
 *
 * Config isolation: we redirect os.homedir() to a temp directory via
 * jest.unstable_mockModule so the tests never touch ~/.memoriahub. The ui
 * module is mocked so warnings can be asserted without terminal noise.
 * All MEMORIAHUB_* env vars are saved/restored between tests.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as actualOs from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Fake home dir (config isolation)
// ---------------------------------------------------------------------------
let _fakeHome = '';

jest.unstable_mockModule('os', () => ({
  ...actualOs,
  homedir: jest.fn(() => _fakeHome || actualOs.homedir()),
}));

// ---------------------------------------------------------------------------
// Mock ui so warnings are capturable and silent
// ---------------------------------------------------------------------------
const mockWarn = jest.fn();

jest.unstable_mockModule('../src/ui.js', () => ({
  ui: {
    success: jest.fn(),
    error: jest.fn(),
    warn: mockWarn,
    info: jest.fn(),
    dim: jest.fn(),
    step: jest.fn(),
    line: jest.fn(),
    blank: jest.fn(),
  },
}));

// Dynamic imports AFTER unstable_mockModule calls
const { loadConfig, saveConfig, configPath, envConfigComplete } = await import(
  '../src/config.js'
);
type CliConfig = import('../src/config.js').CliConfig;

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  'MEMORIAHUB_URL',
  'MEMORIAHUB_TOKEN',
  'MEMORIAHUB_NODE_ID',
  'MEMORIAHUB_NODE_NAME',
  'MEMORIAHUB_CONCURRENCY',
  'MEMORIAHUB_ELIGIBLE_TYPES',
  'MEMORIAHUB_POLL_INTERVAL_MS',
  'MEMORIAHUB_FACE_PROVIDER',
  'MEMORIAHUB_COMPREFACE_URL',
  'MEMORIAHUB_STATE_DIR',
] as const;

let savedEnv: Record<string, string | undefined> = {};

function clearMemoriahubEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfigFile(config: CliConfig): void {
  const dir = path.join(_fakeHome, '.memoriahub');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

const FILE_CONFIG: CliConfig = {
  serverUrl: 'https://file.example.com',
  pat: 'pat_from_file',
  activeCircleId: 'circle-1',
  nodeId: 'node-file',
  node: {
    concurrency: 2,
    eligibleTypes: ['face_detection'],
    pollIntervalMs: 5000,
    name: 'file-node',
    faceProvider: 'human',
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config env overlay', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'mh-config-env-test-'));
    _fakeHome = tmpHome;
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    clearMemoriahubEnv();
    mockWarn.mockClear();
  });

  afterEach(() => {
    _fakeHome = '';
    fs.rmSync(tmpHome, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe('loadConfig — no config file', () => {
    it('should return null with no env vars set (existing semantics)', () => {
      expect(loadConfig()).toBeNull();
    });

    it('should return null when only MEMORIAHUB_URL is set', () => {
      process.env['MEMORIAHUB_URL'] = 'https://env.example.com';
      expect(loadConfig()).toBeNull();
    });

    it('should return null when only MEMORIAHUB_TOKEN is set', () => {
      process.env['MEMORIAHUB_TOKEN'] = 'pat_env';
      expect(loadConfig()).toBeNull();
    });

    it('should synthesize a config from MEMORIAHUB_URL + MEMORIAHUB_TOKEN alone', () => {
      process.env['MEMORIAHUB_URL'] = 'https://env.example.com';
      process.env['MEMORIAHUB_TOKEN'] = 'pat_env';

      const cfg = loadConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.serverUrl).toBe('https://env.example.com');
      expect(cfg!.pat).toBe('pat_env');
      expect(cfg!.node).toBeUndefined();
    });

    it('should synthesize node settings from the full env set', () => {
      process.env['MEMORIAHUB_URL'] = 'https://env.example.com';
      process.env['MEMORIAHUB_TOKEN'] = 'pat_env';
      process.env['MEMORIAHUB_NODE_ID'] = 'node-env';
      process.env['MEMORIAHUB_NODE_NAME'] = 'env-node';
      process.env['MEMORIAHUB_CONCURRENCY'] = '3';
      process.env['MEMORIAHUB_ELIGIBLE_TYPES'] = 'face_detection,auto_tagging';
      process.env['MEMORIAHUB_POLL_INTERVAL_MS'] = '7000';
      process.env['MEMORIAHUB_FACE_PROVIDER'] = 'compreface';
      process.env['MEMORIAHUB_COMPREFACE_URL'] = 'http://compreface:3000';

      const cfg = loadConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.nodeId).toBe('node-env');
      expect(cfg!.node).toEqual({
        name: 'env-node',
        concurrency: 3,
        eligibleTypes: ['face_detection', 'auto_tagging'],
        pollIntervalMs: 7000,
        faceProvider: 'compreface',
        comprefaceUrl: 'http://compreface:3000',
      });
    });
  });

  describe('loadConfig — env wins over file', () => {
    it('should return the file config untouched when no env vars are set', () => {
      writeConfigFile(FILE_CONFIG);
      expect(loadConfig()).toEqual(FILE_CONFIG);
    });

    it('should overlay env per-field and keep file-only fields', () => {
      writeConfigFile(FILE_CONFIG);
      process.env['MEMORIAHUB_URL'] = 'https://env.example.com';
      process.env['MEMORIAHUB_NODE_ID'] = 'node-env';
      process.env['MEMORIAHUB_CONCURRENCY'] = '8';

      const cfg = loadConfig();
      expect(cfg!.serverUrl).toBe('https://env.example.com'); // env wins
      expect(cfg!.pat).toBe('pat_from_file'); // no env → file value
      expect(cfg!.activeCircleId).toBe('circle-1'); // file-only field survives
      expect(cfg!.nodeId).toBe('node-env'); // env wins
      expect(cfg!.node!.concurrency).toBe(8); // env wins
      expect(cfg!.node!.name).toBe('file-node'); // no env → file value
      expect(cfg!.node!.eligibleTypes).toEqual(['face_detection']);
    });
  });

  describe('loadConfig — env value parsing', () => {
    beforeEach(() => {
      process.env['MEMORIAHUB_URL'] = 'https://env.example.com';
      process.env['MEMORIAHUB_TOKEN'] = 'pat_env';
    });

    it('should trim and drop empty entries in MEMORIAHUB_ELIGIBLE_TYPES', () => {
      process.env['MEMORIAHUB_ELIGIBLE_TYPES'] = ' face_detection , auto_tagging ,, geocode ,';

      const cfg = loadConfig();
      expect(cfg!.node!.eligibleTypes).toEqual(['face_detection', 'auto_tagging', 'geocode']);
    });

    it('should ignore an invalid MEMORIAHUB_CONCURRENCY with a warning', () => {
      writeConfigFile(FILE_CONFIG);
      process.env['MEMORIAHUB_CONCURRENCY'] = 'lots';

      const cfg = loadConfig();
      expect(cfg!.node!.concurrency).toBe(2); // file value preserved
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('MEMORIAHUB_CONCURRENCY'));
    });

    it('should ignore a non-positive MEMORIAHUB_CONCURRENCY with a warning', () => {
      process.env['MEMORIAHUB_CONCURRENCY'] = '0';

      const cfg = loadConfig();
      expect(cfg!.node).toBeUndefined();
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('MEMORIAHUB_CONCURRENCY'));
    });

    it('should parse a valid MEMORIAHUB_POLL_INTERVAL_MS', () => {
      process.env['MEMORIAHUB_POLL_INTERVAL_MS'] = '15000';

      const cfg = loadConfig();
      expect(cfg!.node!.pollIntervalMs).toBe(15000);
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('should ignore an invalid MEMORIAHUB_FACE_PROVIDER with a warning', () => {
      writeConfigFile(FILE_CONFIG);
      process.env['MEMORIAHUB_FACE_PROVIDER'] = 'rekognition';

      const cfg = loadConfig();
      expect(cfg!.node!.faceProvider).toBe('human'); // file value preserved
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('MEMORIAHUB_FACE_PROVIDER'));
    });

    it('should accept a valid MEMORIAHUB_FACE_PROVIDER', () => {
      process.env['MEMORIAHUB_FACE_PROVIDER'] = 'compreface';

      const cfg = loadConfig();
      expect(cfg!.node!.faceProvider).toBe('compreface');
      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('envConfigComplete', () => {
    it('should be false with neither or only one of URL/TOKEN set', () => {
      expect(envConfigComplete()).toBe(false);
      process.env['MEMORIAHUB_URL'] = 'https://env.example.com';
      expect(envConfigComplete()).toBe(false);
    });

    it('should be true when both MEMORIAHUB_URL and MEMORIAHUB_TOKEN are set', () => {
      process.env['MEMORIAHUB_URL'] = 'https://env.example.com';
      process.env['MEMORIAHUB_TOKEN'] = 'pat_env';
      expect(envConfigComplete()).toBe(true);
    });
  });

  describe('saveConfig — best-effort persistence for env-driven config', () => {
    function blockConfigDir(): void {
      // A regular file at ~/.memoriahub makes mkdirSync/writeFileSync fail,
      // simulating a read-only or otherwise unwritable home directory.
      fs.writeFileSync(path.join(tmpHome, '.memoriahub'), 'not a directory');
    }

    it('should warn and continue on write failure when env config is complete', () => {
      process.env['MEMORIAHUB_URL'] = 'https://env.example.com';
      process.env['MEMORIAHUB_TOKEN'] = 'pat_env';
      blockConfigDir();

      expect(() =>
        saveConfig({ serverUrl: 'https://env.example.com', pat: 'pat_env', nodeId: 'n1' }),
      ).not.toThrow();
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('Could not persist config'));
    });

    it('should still fail loudly on write failure for file-based flows', () => {
      blockConfigDir();

      expect(() =>
        saveConfig({ serverUrl: 'https://file.example.com', pat: 'pat_file' }),
      ).toThrow();
    });

    it('should write the config normally when the directory is writable', () => {
      process.env['MEMORIAHUB_URL'] = 'https://env.example.com';
      process.env['MEMORIAHUB_TOKEN'] = 'pat_env';

      saveConfig({ serverUrl: 'https://env.example.com', pat: 'pat_env', nodeId: 'n1' });

      const raw = fs.readFileSync(configPath(), 'utf-8');
      expect(JSON.parse(raw).nodeId).toBe('n1');
      expect(mockWarn).not.toHaveBeenCalled();
    });
  });
});
