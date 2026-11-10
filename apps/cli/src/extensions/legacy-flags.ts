// (The `menu` rule is permanent: `menu` is the 1.3 spelling of a bare `memoriahub`. The `node` rule was
// removed by RETRO-C10: the platform `node` group runs MemoriaHub's executors.)

// =============================================================================
// Legacy spellings, translated in one place  (issue #577, RETRO-F3)
// =============================================================================
//
// The hard rule of the cutover to `createCli` is zero feature loss: every
// command, subcommand and flag that worked on 1.3.x either still works through
// the app's own commands, resolves to a platform built-in with the same meaning,
// or is rewritten here before the platform parses it. Nothing is silently
// dropped. `translateLegacyArgs` is pure (no process state, no I/O) so every
// rule is a plain test case (test/legacy-flags.spec.ts).
//
// Each rule has a disposition:
//
//   IGNORE  the spelling needs no rewrite beyond its side effect
//   ALIAS   rewritten to the platform spelling with identical meaning
//   PORT    the behaviour is kept by the app (a command the platform lacks)
//   REFUSE  no equivalent: refused with a message, never silently ignored
//
// RULES (the table docs/ and apps/cli/README.md "Commands that changed in 1.4" mirror):
//
//   id            disposition  legacy spelling                    becomes
//   no-color      IGNORE       `--no-color` anywhere              stripped; NO_COLOR=1
//   short-version ALIAS        `-V` (before any command)          `--version`
//   menu          ALIAS        `menu` (alone)                      a bare `memoriahub` (the platform TUI)
//   deploy-env    ALIAS        MEMORIAHUB_DOMAIN/PORT/HOME/REF/REPO  --domain/--port/--root/--ref/--repo
//   deploy-defaults ALIAS      `deploy install` without them      --root /opt/infra/apps/memoriahub, --port 8328,
//                                                                  --domain memoriahub.marin.cr (the old installer's defaults)
//
// `login --token <pat>` and `login --server <url>` are native flags of the
// platform `login`, so they need no rule. `jobs|queue` is an app command with its
// original name and aliases.
// =============================================================================

/** The defaults `infra/deploy/install.sh` baked in, preserved for `deploy install`. */
export const LEGACY_DEPLOY_DEFAULTS = Object.freeze({
  root: '/opt/infra/apps/memoriahub',
  port: '8328',
  domain: 'memoriahub.marin.cr',
});

/** The outcome of translating one invocation. */
export interface LegacyPlan {
  /** The arguments to hand on to the platform CLI. */
  argv: string[];
  /** Environment variables the caller must set before running (never read from here). */
  env: Record<string, string>;
  /** One-line notices for stderr. */
  notes: string[];
  /** Set when a legacy spelling has no equivalent; print it and exit with a usage error. */
  refuse?: string;
  /** Ids of the rules that fired, for tests and diagnostics. */
  applied: string[];
}

/** What the rules may read; injected so the function stays pure. */
export interface LegacyContext {
  env: Readonly<Record<string, string | undefined>>;
}

const DEPLOY_SUBCOMMANDS = new Set(['install', 'update', 'doctor']);

function hasFlag(argv: readonly string[], ...names: string[]): boolean {
  return argv.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
}

/** Index of the first token that is not an option (the command word), or -1. */
function commandIndex(argv: readonly string[]): number {
  return argv.findIndex((a) => !a.startsWith('-'));
}

/**
 * Translates the pre-platform spellings of one invocation.
 *
 * @param argv - The arguments after the executable name.
 * @param context - The environment the deploy rules read.
 * @returns the plan; never throws.
 */
export function translateLegacyArgs(argv: readonly string[], context: LegacyContext): LegacyPlan {
  const env = context.env;
  const plan: LegacyPlan = { argv: [...argv], env: {}, notes: [], applied: [] };

  // --- no-color: IGNORE -------------------------------------------------------
  // Honoured before anything else so chalk picks it up; stripped because the
  // platform's deploy commands define their own --no-color with narrower scope.
  const dashDash = plan.argv.indexOf('--');
  const limit = dashDash === -1 ? plan.argv.length : dashDash;
  if (plan.argv.slice(0, limit).includes('--no-color')) {
    plan.argv = plan.argv.filter((a, i) => !(a === '--no-color' && i < limit));
    plan.env['NO_COLOR'] = '1';
    plan.applied.push('no-color');
  }

  // --- short-version: ALIAS ---------------------------------------------------
  // 1.3 declared `-V, --version`; the platform's short flag is `-v`.
  const cmdAt = commandIndex(plan.argv);
  const rootFlags = cmdAt === -1 ? plan.argv : plan.argv.slice(0, cmdAt);
  if (rootFlags.includes('-V')) {
    plan.argv = plan.argv.map((a, i) => (a === '-V' && (cmdAt === -1 || i < cmdAt) ? '--version' : a));
    plan.applied.push('short-version');
  }

  // --- menu: ALIAS ------------------------------------------------------------
  // 1.3's `menu` opened the TUI; the platform TUI opens for a bare invocation.
  if (plan.argv.length === 1 && plan.argv[0] === 'menu') {
    plan.argv = [];
    plan.applied.push('menu');
    return plan;
  }

  // --- deploy-env / deploy-defaults: ALIAS ------------------------------------
  if (plan.argv[0] === 'deploy' && DEPLOY_SUBCOMMANDS.has(plan.argv[1] ?? '')) {
    const sub = plan.argv[1] as string;
    const rest = plan.argv.slice(2);
    const extra: string[] = [];
    const via = (flag: string, value: string | undefined, label: string): void => {
      if (value === undefined || value === '' || hasFlag(rest, flag)) return;
      extra.push(flag, value);
      plan.applied.push(label);
    };

    if (!hasFlag(rest, '--name', '--apps-root')) {
      via('--root', env['MEMORIAHUB_HOME'] || (sub === 'install' ? LEGACY_DEPLOY_DEFAULTS.root : undefined), 'deploy-root');
    }
    if (sub !== 'update') {
      via('--port', env['MEMORIAHUB_PORT'] || (sub === 'install' ? LEGACY_DEPLOY_DEFAULTS.port : undefined), 'deploy-port');
    }
    if (sub === 'install' || sub === 'doctor') {
      const domain = env['MEMORIAHUB_DOMAIN'];
      if (domain) {
        via('--domain', domain, 'deploy-domain');
      } else if (sub === 'install' && !hasFlag(rest, '--domain', '--skip-proxy')) {
        via('--domain', LEGACY_DEPLOY_DEFAULTS.domain, 'deploy-domain');
        plan.notes.push(
          `memoriahub: using the legacy default domain ${LEGACY_DEPLOY_DEFAULTS.domain} and host port ` +
            `${LEGACY_DEPLOY_DEFAULTS.port}; pass --domain/--port or set MEMORIAHUB_DOMAIN/MEMORIAHUB_PORT to change them.`,
        );
      }
    }
    if (sub !== 'doctor') via('--ref', env['MEMORIAHUB_REF'], 'deploy-ref');
    if (sub === 'install') via('--repo', env['MEMORIAHUB_REPO'], 'deploy-repo');

    if (extra.length > 0) plan.argv = [...plan.argv.slice(0, 2), ...extra, ...rest];
  }

  return plan;
}
