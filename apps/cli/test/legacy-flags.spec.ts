import { LEGACY_DEPLOY_DEFAULTS, translateLegacyArgs } from '../src/extensions/legacy-flags.js';

// One case per rule of the table in src/extensions/legacy-flags.ts (issue #577).
const t = (argv: string[], env: Record<string, string> = {}) => translateLegacyArgs(argv, { env });

describe('translateLegacyArgs', () => {
  it('passes an ordinary invocation through untouched', () => {
    const plan = t(['sync', '--circle', 'x']);
    expect(plan.argv).toEqual(['sync', '--circle', 'x']);
    expect(plan.applied).toEqual([]);
  });

  describe('no-color (IGNORE)', () => {
    it('strips --no-color anywhere and sets NO_COLOR=1', () => {
      const plan = t(['sync', '--no-color', 'folder']);
      expect(plan.argv).toEqual(['sync', 'folder']);
      expect(plan.env).toEqual({ NO_COLOR: '1' });
    });
    it('leaves arguments after -- alone', () => {
      expect(t(['api', '--', '--no-color']).argv).toEqual(['api', '--', '--no-color']);
    });
  });

  describe('short-version (ALIAS)', () => {
    it('rewrites a root-level -V to --version', () => {
      expect(t(['-V']).argv).toEqual(['--version']);
    });
    it('does not touch -V after a command', () => {
      expect(t(['sync', '-V']).argv).toEqual(['sync', '-V']);
    });
  });

  describe('menu (ALIAS)', () => {
    it('rewrites a lone `menu` to a bare invocation, which opens the platform TUI', () => {
      const plan = t(['menu']);
      expect(plan.argv).toEqual([]);
      expect(plan.applied).toContain('menu');
    });
    it('leaves `menu` with other arguments to the app command', () => {
      expect(t(['menu', '--help']).argv).toEqual(['menu', '--help']);
    });
  });

  describe('deploy-env / deploy-defaults (ALIAS)', () => {
    it('install gets the old installer defaults and says so', () => {
      const plan = t(['deploy', 'install']);
      expect(plan.argv).toEqual([
        'deploy', 'install',
        '--root', LEGACY_DEPLOY_DEFAULTS.root,
        '--port', LEGACY_DEPLOY_DEFAULTS.port,
        '--domain', LEGACY_DEPLOY_DEFAULTS.domain,
      ]);
      expect(plan.notes.join('\n')).toContain('legacy default domain');
    });
    it('MEMORIAHUB_* variables map to flags', () => {
      const plan = t(['deploy', 'install'], {
        MEMORIAHUB_HOME: '/srv/mh', MEMORIAHUB_PORT: '9000', MEMORIAHUB_DOMAIN: 'mh.example.test',
        MEMORIAHUB_REF: 'v1', MEMORIAHUB_REPO: 'https://example.test/r.git',
      });
      expect(plan.argv).toEqual(expect.arrayContaining(['--root', '/srv/mh', '--port', '9000', '--domain', 'mh.example.test', '--ref', 'v1', '--repo', 'https://example.test/r.git']));
      expect(plan.notes).toEqual([]);
    });
    it('an explicit flag beats the variable and the default', () => {
      const plan = t(['deploy', 'install', '--port', '1234', '--domain=a.example.test', '--root', '/x'], { MEMORIAHUB_PORT: '9' });
      expect(plan.argv).toEqual(['deploy', 'install', '--port', '1234', '--domain=a.example.test', '--root', '/x']);
    });
    it('--skip-proxy installs get no default domain', () => {
      expect(t(['deploy', 'install', '--skip-proxy']).argv).not.toContain('--domain');
    });
    it('update only maps the variables that exist (no defaults)', () => {
      expect(t(['deploy', 'update']).argv).toEqual(['deploy', 'update']);
      expect(t(['deploy', 'update', '--no-cache', '--skip-proxy'], { MEMORIAHUB_REF: 'main' }).argv)
        .toEqual(['deploy', 'update', '--ref', 'main', '--no-cache', '--skip-proxy']);
    });
    it('leaves other deploy subcommands alone', () => {
      expect(t(['deploy', 'status']).argv).toEqual(['deploy', 'status']);
    });
  });
});
