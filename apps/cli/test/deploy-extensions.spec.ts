import { testDeployStepContext } from '@marinoscar/platform-cli/testing';
import type { DeployCheckContext } from '@marinoscar/platform-cli/deploy';

import { createModelsDirCheck, createPgvectorCheck } from '../src/extensions/deploy-checks.js';
import { APP_DEPLOY_STEPS, assertPgvectorAvailable, reportCompreface } from '../src/extensions/deploy-steps.js';
import {
  PGVECTOR_ABSENT,
  PGVECTOR_PRESENT,
  composePrefix,
  pgvectorProbeArgv,
  readPgvectorVerdict,
} from '../src/extensions/deployment.js';

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });

function stepContext(stdout: string, exitCode = 0) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const context = testDeployStepContext({
    checkoutPath: '/srv/mh/repo',
    log: (line: string) => void logs.push(line),
    exec: async (argv: readonly string[]) => {
      calls.push([...argv]);
      return { exitCode, stdout, stderr: '' };
    },
  });
  return { context, calls, logs };
}

describe('deployment helpers', () => {
  it('runs the vps-mode compose files, probing from inside the api container', () => {
    const argv = pgvectorProbeArgv('/srv/mh/repo');
    expect(argv.slice(0, 2)).toEqual(['docker', 'compose']);
    expect(argv).toEqual(expect.arrayContaining(['-f', 'vps.compose.yml', 'run', '--rm', '-T', '--no-deps', 'api', 'node', '-e']));
    expect(composePrefix('/srv/mh/repo')).toContain('base.compose.yml');
  });

  it('never passes a secret on the command line', () => {
    expect(pgvectorProbeArgv('/x').join(' ')).not.toMatch(/PASSWORD=/);
  });

  it('reads the verdict, and never guesses', () => {
    expect(readPgvectorVerdict(ok(PGVECTOR_PRESENT))).toEqual({ status: 'present' });
    expect(readPgvectorVerdict(ok(PGVECTOR_ABSENT))).toEqual({ status: 'absent' });
    expect(readPgvectorVerdict({ exitCode: 2, stdout: '', stderr: 'ECONNREFUSED' })).toEqual({ status: 'unknown', detail: 'ECONNREFUSED' });
  });
});

describe('database-extensions step', () => {
  it('passes when pgvector is available', async () => {
    const { context, logs } = stepContext(PGVECTOR_PRESENT);
    await expect(assertPgvectorAvailable(context)).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('pgvector is available');
  });
  it('fails with a remedy when it is absent', async () => {
    const { context } = stepContext(PGVECTOR_ABSENT);
    await expect(assertPgvectorAvailable(context)).rejects.toThrow(/pgvector/);
  });
  it('does not block the deploy when the probe itself failed', async () => {
    const { context, logs } = stepContext('', 2);
    await expect(assertPgvectorAvailable(context)).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('Could not verify pgvector');
  });
});

describe('compreface-healthy step', () => {
  it('reports a running sidecar', async () => {
    const { context } = stepContext('api\ncompreface-core\nweb\n');
    await expect(reportCompreface(context)).resolves.toBe(true);
  });
  it('warns, never throws, when it is not running', async () => {
    const { context, logs } = stepContext('api\nweb\n');
    await expect(reportCompreface(context)).resolves.toBe(false);
    expect(logs.join('\n')).toContain('not running');
  });
});

describe('registrations', () => {
  it('anchor on built-in step ids of the right pipeline', () => {
    const anchors = APP_DEPLOY_STEPS.map((s) => [s.pipeline, s.before ?? s.after]);
    expect(anchors).toEqual([['install', 'migrate'], ['update', 'migrate'], ['install', 'start'], ['update', 'restart']]);
  });
});

const checkContext = (over: Partial<DeployCheckContext> = {}): DeployCheckContext => ({
  deployRoot: '/srv/mh', bindPort: 8328, proxyRoot: '/srv/proxy', domain: undefined, env: undefined, skipProxy: false, ...over,
});

describe('pgvector-available check', () => {
  it('is required', () => expect(createPgvectorCheck().severity).toBe('required'));
  it('skips before a checkout exists', async () => {
    const check = createPgvectorCheck(async () => ok(''), () => false);
    expect((await check.run(checkContext())).status).toBe('skip');
  });
  it('passes, fails and warns by the probe verdict', async () => {
    const run = (stdout: string, code = 0) => createPgvectorCheck(async () => ({ exitCode: code, stdout, stderr: 'boom' }), () => true).run(checkContext());
    expect((await run(PGVECTOR_PRESENT)).status).toBe('pass');
    expect((await run(PGVECTOR_ABSENT)).status).toBe('fail');
    expect((await run('', 2)).status).toBe('warn');
  });
});

describe('models-dir check', () => {
  const env = (v: Record<string, string>) => ({ has: (k: string) => k in v, get: (k: string) => v[k], keys: () => Object.keys(v) });
  it('warns on a relative MODELS_DIR', async () => {
    expect((await createModelsDirCheck(() => true).run(checkContext({ env: env({ MODELS_DIR: 'data/models' }) }))).status).toBe('warn');
  });
  it('passes when the overlay is present, warns when it is gone, skips with no checkout', async () => {
    expect((await createModelsDirCheck(() => true).run(checkContext())).status).toBe('pass');
    expect((await createModelsDirCheck((p) => !p.endsWith('app.models-volume.compose.yml')).run(checkContext())).status).toBe('warn');
    expect((await createModelsDirCheck(() => false).run(checkContext())).status).toBe('skip');
  });
});
