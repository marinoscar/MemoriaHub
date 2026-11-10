import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WORKER_ENV_ALIASES, applyLegacyWorkerEnv } from '../src/worker-env.js';
import { legacyDaemonNotice } from '../src/extensions/legacy-daemon-notice.js';
import { nodeRows } from '../src/extensions/node-list.js';

describe('applyLegacyWorkerEnv', () => {
  it('mirrors the 1.3 names without overriding a value that is set', () => {
    const env: NodeJS.ProcessEnv = { MEMORIAHUB_SHARP_CONCURRENCY: '3', MODELS_DIR: '/app/models' };
    const notes = applyLegacyWorkerEnv(env, '/nonexistent-home');
    expect(env['MEMORIAHUB_NATIVE_THREADS']).toBe('3');
    expect(env['MEMORIAHUB_MODELS_DIR']).toBe('/app/models');
    expect(env['MEMORIAHUB_COMPREFACE_URL']).toBe('http://localhost:3000');
    expect(notes.join('\n')).toContain('MEMORIAHUB_SHARP_CONCURRENCY is deprecated');

    const set: NodeJS.ProcessEnv = { MEMORIAHUB_SHARP_CONCURRENCY: '3', MEMORIAHUB_NATIVE_THREADS: '1', MEMORIAHUB_COMPREFACE_URL: 'http://cf:3000' };
    applyLegacyWorkerEnv(set, '/nonexistent-home');
    expect(set['MEMORIAHUB_NATIVE_THREADS']).toBe('1');
    expect(set['MEMORIAHUB_COMPREFACE_URL']).toBe('http://cf:3000');
  });

  it('keeps a 1.3 models directory in place instead of downloading again', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-home-'));
    fs.mkdirSync(path.join(home, '.memoriahub', 'models'), { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    applyLegacyWorkerEnv(env, home);
    expect(env['MEMORIAHUB_MODELS_DIR']).toBe(path.join(home, '.memoriahub', 'models'));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports ignored and refused settings', () => {
    const notes = applyLegacyWorkerEnv({ MEMORIAHUB_STARTUP_SELFTEST: '0', MEMORIAHUB_FACE_PROVIDER: 'human' }, '/x');
    expect(notes.join('\n')).toMatch(/STARTUP_SELFTEST is ignored/);
    expect(notes.join('\n')).toMatch(/not supported/);
  });

  it('names the legacy heap variables as platform aliases', () => {
    expect(WORKER_ENV_ALIASES).toEqual({
      heapLimitMb: ['MEMORIAHUB_MAX_OLD_SPACE_MB'],
      heapSnapshots: ['MEMORIAHUB_HEAP_SNAPSHOT'],
      memoryWatchdog: ['MEMORIAHUB_MEMWATCH'],
      memoryThreshold: ['MEMORIAHUB_HEAP_RESTART_FRACTION'],
    });
  });
});

describe('legacyDaemonNotice', () => {
  it('names a live 1.3 daemon and clears the files of a dead one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-legacy-'));
    fs.writeFileSync(path.join(dir, 'node.pid'), String(process.pid));
    expect(legacyDaemonNotice(dir)).toContain(`pid ${process.pid}`);
    fs.writeFileSync(path.join(dir, 'node.pid'), '2147483646');
    fs.writeFileSync(path.join(dir, 'node.sock'), '');
    expect(legacyDaemonNotice(dir)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'node.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'node.sock'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('nodeRows', () => {
  it('reads a bare list and an items envelope', () => {
    expect(nodeRows([{ id: 'a' }])).toEqual([{ id: 'a' }]);
    expect(nodeRows({ items: [{ id: 'b' }] })).toEqual([{ id: 'b' }]);
    expect(nodeRows(null)).toEqual([]);
  });
});
