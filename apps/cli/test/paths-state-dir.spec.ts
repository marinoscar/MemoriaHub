/**
 * paths-state-dir.spec.ts — Unit tests for the MEMORIAHUB_STATE_DIR override.
 *
 * All state paths (config dir, db, manifests, exports, models, logs, pidfile,
 * IPC socket) derive from configDir(), so setting MEMORIAHUB_STATE_DIR must
 * relocate every one of them. The env var is saved/restored between tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configDir,
  dbPath,
  manifestsDir,
  exportsDir,
  modelsDir,
  logsDir,
  runDir,
  nodePidPath,
  nodeSocketPath,
} from '../src/paths.js';
import { configPath } from '../src/config.js';

describe('paths — MEMORIAHUB_STATE_DIR override', () => {
  let tmpState: string;
  let savedStateDir: string | undefined;

  beforeEach(() => {
    tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-state-dir-test-'));
    savedStateDir = process.env['MEMORIAHUB_STATE_DIR'];
    delete process.env['MEMORIAHUB_STATE_DIR'];
  });

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env['MEMORIAHUB_STATE_DIR'];
    else process.env['MEMORIAHUB_STATE_DIR'] = savedStateDir;
    fs.rmSync(tmpState, { recursive: true, force: true });
  });

  it('should default to ~/.memoriahub when the env var is unset', () => {
    expect(configDir()).toBe(path.join(os.homedir(), '.memoriahub'));
  });

  it('should default to ~/.memoriahub when the env var is blank', () => {
    process.env['MEMORIAHUB_STATE_DIR'] = '   ';
    expect(configDir()).toBe(path.join(os.homedir(), '.memoriahub'));
  });

  it('should relocate configDir to the override directory', () => {
    process.env['MEMORIAHUB_STATE_DIR'] = tmpState;
    expect(configDir()).toBe(tmpState);
  });

  it('should relocate every derived path under the override directory', () => {
    process.env['MEMORIAHUB_STATE_DIR'] = tmpState;

    expect(configPath()).toBe(path.join(tmpState, 'config.json'));
    expect(dbPath()).toBe(path.join(tmpState, 'memoriahub.db'));
    expect(manifestsDir()).toBe(path.join(tmpState, 'manifests'));
    expect(exportsDir()).toBe(path.join(tmpState, 'exports'));
    expect(modelsDir()).toBe(path.join(tmpState, 'models'));
    expect(logsDir()).toBe(path.join(tmpState, 'logs'));
    expect(runDir()).toBe(tmpState);
    expect(nodePidPath()).toBe(path.join(tmpState, 'node.pid'));
    if (os.platform() !== 'win32') {
      expect(nodeSocketPath()).toBe(path.join(tmpState, 'node.sock'));
    }
  });
});
