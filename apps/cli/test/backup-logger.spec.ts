import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createBackupLogger, redactSensitive } from '../src/backup/logger.js';

describe('backup logger (the 1.3 node logger, trimmed)', () => {
  it('redacts credential-shaped fields and keeps the rest', () => {
    expect(redactSensitive({ pat: 'x', path: '/a', nested: { apiKey: 'k', ok: 1 }, authToken: 't' })).toEqual({
      pat: '[REDACTED]',
      path: '/a',
      nested: { apiKey: '[REDACTED]', ok: 1 },
      authToken: '[REDACTED]',
    });
  });

  it('writes redacted JSONL, tails it and rolls over past the size cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-log-'));
    const log = createBackupLogger({ dir, maxBytes: 1024 });
    log.info('hello', { token: 'secret-value', n: 1 });
    const raw = fs.readFileSync(log.logPath, 'utf8');
    expect(raw).toContain('"msg":"hello"');
    expect(raw).not.toContain('secret-value');
    expect(log.tail(1)).toHaveLength(1);
    for (let i = 0; i < 40; i += 1) log.info('x'.repeat(60), { i });
    expect(fs.existsSync(`${log.logPath}.1`)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
