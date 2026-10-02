/**
 * commands/android.ts — `memoriahub android …`: build, sign, version and
 * publish the Android app (issue #517, epic #498).
 *
 *   android doctor   [--fix] [--yes] [--dry-run] [--json]
 *   android keystore init [--alias] [--dname] | import <file> [--alias] | show | secrets
 *   android version  [--bump patch|minor|major] [--set x.y.z] [--code n] [--json]
 *   android build    [--server-url <url>] [--debug]
 *   android publish  [apk] [--notes <t>] [--no-current] [--force]
 *   android releases [--json] | releases current <id> [--yes]
 *   android release  [--bump patch|minor|major] [--notes <t>] [--server-url <url>] [--no-commit]
 *
 * `--repo <path>` (on `android`) points every command at a checkout;
 * otherwise MEMORIAHUB_REPO_ROOT, otherwise the nearest ancestor of the cwd
 * holding apps/android/version.properties. `releases`, `publish <apk>` and
 * `keystore …` work without a checkout.
 *
 * Output: progress goes to STDERR; STDOUT carries only what a script would
 * capture (a version, a path, a release id, a table, `--json`). Exit codes:
 * 0 ok, 1 a tool/server failure, 2 bad usage, 6 something to set up first.
 * The logic lives in src/android/*; this file is argument parsing and printing.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Command } from 'commander';

import { runBuild, type BuildResult } from '../android/build.js';
import { doctorJson, formatAndroidDoctorReport, runAndroidDoctor, type AndroidDoctorReport, type LoginHint } from '../android/doctor.js';
import { EXIT, PreconditionError, UsageError, errorMessage, exitCodeFor } from '../android/errors.js';
import { exec as defaultExec, type ExecFn } from '../android/exec.js';
import { buildFixPlan, executableSteps, executeFixPlan, formatFixPlan, type ProbeRunner, type SudoRunner } from '../android/fix-plan.js';
import { readIdentity } from '../android/identity.js';
import {
  BACKUP_WARNING,
  DEFAULT_DNAME,
  DEFAULT_KEY_ALIAS,
  KEY_PASSWORD_ENV,
  STORE_PASSWORD_ENV,
  generateKeystore,
  githubSecrets,
  importKeystoreFile,
  keystorePath,
  readCertificateSha256,
  readSigningConfig,
  requireSigning,
  signingConfigPath,
  writeSigningConfig,
  type SigningConfig,
} from '../android/keystore.js';
import { readBuiltApk } from '../android/metadata.js';
import {
  ANDROID_APP_DIR,
  GRADLE_ARGS_ENV_VAR,
  REPO_ROOT_ENV_VAR,
  distDir,
  requireRepoRoot,
  versionPropertiesPath,
  type AndroidPathsContext,
} from '../android/paths.js';
import { canPrompt, confirm as defaultConfirm, promptSecret as defaultPromptSecret } from '../android/prompt.js';
import {
  PUBLISH_PERMISSION,
  apiClientFor,
  downloadPageUrl,
  formatBytes,
  formatReleasesTable,
  latestRelease,
  listReleases,
  makeCurrent,
  publishRelease,
  requirePublishPermission,
  rollbackWarning,
  storedCredentials,
  type AndroidRelease,
  type JsonApi,
  type ServerCredentials,
} from '../android/publish.js';
import { commitVersionFile, releasePrechecks, runRelease } from '../android/release.js';
import {
  applyVersionChange,
  bumpVersionFile,
  parseBumpPart,
  readVersion,
  versionLabel,
  writeVersion,
  type BumpPart,
} from '../android/version.js';

export interface AndroidCommandContext {
  stdout?: { write(chunk: string): unknown } | undefined;
  stderr?: { write(chunk: string): unknown; isTTY?: boolean } | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  cwd?: string | undefined;
  exec?: ExecFn | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  credentials?: (() => ServerCredentials | undefined) | undefined;
  client?: ((credentials: ServerCredentials, options?: { quick?: boolean }) => JsonApi) | undefined;
  confirm?: ((question: string) => Promise<boolean>) | undefined;
  promptSecret?: ((question: string) => Promise<string>) | undefined;
  /** `doctor --fix` seams. */
  sudo?: SudoRunner | undefined;
  probe?: ProbeRunner | undefined;
  linuxFamily?: (() => 'debian' | 'other') | undefined;
  isRoot?: (() => boolean) | undefined;
  platform?: NodeJS.Platform | undefined;
  /** Called instead of setting `process.exitCode` (tests). */
  onExit?: ((code: number) => void) | undefined;
}

export function androidCommand(ctx: AndroidCommandContext = {}): Command {
  const env = (): NodeJS.ProcessEnv => ctx.env ?? process.env;
  const out = (text: string): void => {
    (ctx.stdout ?? process.stdout).write(text);
  };
  const log = (line: string): void => {
    (ctx.stderr ?? process.stderr).write(`${line}\n`);
  };
  const exec = (): ExecFn => ctx.exec ?? defaultExec;
  const confirm = ctx.confirm ?? defaultConfirm;
  const promptSecret = ctx.promptSecret ?? defaultPromptSecret;
  const interactive = (): boolean => ctx.confirm !== undefined || canPrompt();

  const android = new Command('android')
    .description('Build, sign, version and publish the Android app')
    .option('--repo <path>', `MemoriaHub checkout to use (else ${REPO_ROOT_ENV_VAR}, else the nearest ancestor with ${ANDROID_APP_DIR})`)
    .addHelpText(
      'after',
      [
        '',
        'Environment:',
        `  ${REPO_ROOT_ENV_VAR}     checkout to use when --repo is not given`,
        `  ${GRADLE_ARGS_ENV_VAR}   extra arguments appended to every Gradle run (e.g. "--no-daemon --max-workers=1")`,
        '  GRADLE_OPTS, JAVA_HOME   passed to Gradle unchanged',
        `  ${STORE_PASSWORD_ENV} / ${KEY_PASSWORD_ENV}   keystore passwords for \`keystore init|import\``,
        '',
        'First release on a fresh machine:',
        '  memoriahub login',
        '  memoriahub android doctor --fix --yes',
        '  memoriahub android keystore init        # then BACK UP ~/.memoriahub/android/',
        '  memoriahub android release --bump patch --notes "…"',
      ].join('\n'),
    );

  const paths = (): AndroidPathsContext => ({
    repo: (android.opts() as { repo?: string }).repo,
    env: env(),
    home: ctx.home,
    cwd: ctx.cwd,
  });
  const credentials = (): ServerCredentials | undefined => (ctx.credentials ?? storedCredentials)();
  const requireLogin = (): ServerCredentials => {
    const found = credentials();
    if (found === undefined) {
      throw new PreconditionError('Not logged in. Run `memoriahub login` first (or set MEMORIAHUB_URL and MEMORIAHUB_TOKEN).');
    }
    return found;
  };
  const client = (creds: ServerCredentials, options?: { quick?: boolean }): JsonApi =>
    ctx.client !== undefined ? ctx.client(creds, options) : apiClientFor(creds, options);

  /** Every action: errors become a message on stderr and an exit code. */
  const action =
    <A extends unknown[]>(fn: (...args: A) => Promise<void> | void) =>
    async (...args: A): Promise<void> => {
      try {
        await fn(...args);
      } catch (error) {
        log(`✖ ${errorMessage(error)}`);
        const code = exitCodeFor(error);
        if (ctx.onExit !== undefined) ctx.onExit(code);
        else process.exitCode = code;
      }
    };
  const exitWith = (code: number): void => {
    if (ctx.onExit !== undefined) ctx.onExit(code);
    else process.exitCode = code;
  };

  // ---- doctor -------------------------------------------------------------------
  const loginHint = async (): Promise<LoginHint> => {
    const creds = credentials();
    if (creds === undefined) return { loggedIn: false, detail: 'Not logged in (needed to publish, not to build)' };
    try {
      const user = await client(creds, { quick: true }).get<{ email?: string; permissions?: string[] }>('/api/auth/me');
      const canPublish = Array.isArray(user.permissions) && user.permissions.includes(PUBLISH_PERMISSION);
      return {
        loggedIn: true,
        detail: `${user.email ?? 'signed in'} on ${creds.serverUrl}${canPublish ? '' : ` (lacks ${PUBLISH_PERMISSION}: cannot publish)`}`,
      };
    } catch (error) {
      return { loggedIn: false, detail: `${creds.serverUrl}: ${errorMessage(error)}` };
    }
  };

  const doctor = (): Promise<AndroidDoctorReport> =>
    runAndroidDoctor({ ...paths(), exec: exec(), platform: ctx.platform, login: loginHint });

  android
    .command('doctor')
    .description('Check the JDK, Android SDK, Gradle wrapper, keystore and login; --fix installs what it can')
    .option('--fix', 'Install the JDK (apt, Debian/Ubuntu) and the Android SDK packages; prints the plan first')
    .option('-y, --yes', 'Run the --fix plan without asking')
    .option('--dry-run', 'Print the --fix plan and execute nothing')
    .option('--json', 'Print the report as JSON on stdout: { ok, checks: [{ id, label, status, detail, fix? }] }')
    .action(
      action(async (options: { fix?: boolean; yes?: boolean; dryRun?: boolean; json?: boolean }) => {
        let report = await doctor();

        if (options.fix === true || options.dryRun === true) {
          const installDeps = ctx.linuxFamily === undefined || ctx.isRoot === undefined ? await import('../node/install-deps.js') : undefined;
          const plan = buildFixPlan(report, {
            platform: ctx.platform,
            linuxFamily: ctx.linuxFamily ?? (() => installDeps!.detectLinuxDistro().family),
            isRoot: ctx.isRoot ?? (() => installDeps!.isRoot()),
          });
          log(formatFixPlan(plan).trimEnd());
          const runnable = executableSteps(plan);
          if (options.dryRun === true) {
            log('Dry run: nothing was executed.');
          } else if (runnable.length === 0) {
            log('Nothing for --fix to install. (A keystore is never created automatically.)');
          } else {
            const go = options.yes === true || (interactive() && (await confirm('Run this plan?')));
            if (!go) {
              log(interactive() ? 'Not executed.' : 'Not executed: pass --yes to run the plan non-interactively.');
            } else {
              await executeFixPlan(plan, {
                exec: exec(),
                log,
                fetch: ctx.fetch,
                env: env(),
                platform: ctx.platform,
                sudo: ctx.sudo,
                probe: ctx.probe,
              });
              if (report.sdk.source !== 'ANDROID_HOME' && report.sdk.source !== 'ANDROID_SDK_ROOT') {
                log(`The SDK is in ${report.sdk.root}; memoriahub finds it by itself. For Android Studio, set ANDROID_HOME=${report.sdk.root}.`);
              }
              report = await doctor();
            }
          }
        }

        if (options.json === true) {
          out(`${JSON.stringify(doctorJson(report), null, 2)}\n`);
        } else {
          (ctx.stderr ?? process.stderr).write(
            formatAndroidDoctorReport(report, { colour: (ctx.stderr ?? process.stderr).isTTY === true && !env()['NO_COLOR'] }),
          );
        }
        if (!report.ok) exitWith(EXIT.PRECONDITION);
      }),
    );

  // ---- keystore -----------------------------------------------------------------
  const keystore = android.command('keystore').description('Manage the release signing keystore (~/.memoriahub/android)');

  keystore
    .command('init')
    .description('Create the release keystore (RSA 4096, valid 100 years). Refuses to overwrite.')
    .option('--alias <alias>', 'Key alias', DEFAULT_KEY_ALIAS)
    .option('--dname <dn>', 'Certificate subject (X.500)', DEFAULT_DNAME)
    .action(
      action(async (options: { alias: string; dname: string }) => {
        const target = keystorePath(paths());
        if (readSigningConfig(paths()) !== undefined || existsSync(target)) {
          throw new PreconditionError(
            `A release keystore already exists (${target}). Replacing it would make every installed copy un-updatable; refusing.`,
          );
        }
        const password = await newPassword();
        // PKCS12 keystores have one password: the key password is the store password.
        await generateKeystore(
          { path: target, alias: options.alias, storePassword: password, keyPassword: password, dname: options.dname },
          { exec: exec(), env: env() },
        );
        const config: SigningConfig = { keystorePath: target, keyAlias: options.alias, storePassword: password, keyPassword: password };
        config.certSha256 = await readCertificateSha256(config, { exec: exec(), env: env() });
        writeSigningConfig(config, paths());
        log(`Created ${target} (alias ${options.alias}).`);
        log(`Passwords: ${signingConfigPath(paths())} (mode 0600).`);
        log(`SHA-256:  ${config.certSha256}`);
        log('');
        log(`${BACKUP_WARNING} (Back up ${target} and ${signingConfigPath(paths())}.)`);
        log('`memoriahub android keystore secrets` prints the GitHub Actions secrets for CI.');
        out(`${config.certSha256}\n`);
      }),
    );

  const newPassword = async (): Promise<string> => {
    const fromEnv = env()[STORE_PASSWORD_ENV];
    if (fromEnv !== undefined && fromEnv !== '') return validatePassword(fromEnv);
    if (ctx.promptSecret !== undefined || canPrompt()) {
      const first = await promptSecret('New keystore password (empty to generate one): ');
      if (first !== '') {
        const second = await promptSecret('Repeat it: ');
        if (first !== second) throw new UsageError('The passwords did not match.');
        return validatePassword(first);
      }
    }
    return randomBytes(24).toString('base64url');
  };

  keystore
    .command('import')
    .description(`Use an existing keystore (passwords from ${STORE_PASSWORD_ENV}/${KEY_PASSWORD_ENV}, else a prompt)`)
    .argument('<file>', 'The .jks / .keystore / .p12 file')
    .option('--alias <alias>', 'Key alias', DEFAULT_KEY_ALIAS)
    .action(
      action(async (file: string, options: { alias: string }) => {
        const source = resolve(ctx.cwd ?? process.cwd(), file);
        if (!existsSync(source)) throw new PreconditionError(`${source} does not exist.`);
        const storePassword = await existingPassword(STORE_PASSWORD_ENV, 'Keystore password: ');
        const keyEnv = env()[KEY_PASSWORD_ENV];
        const keyPassword = keyEnv !== undefined && keyEnv !== '' ? keyEnv : storePassword;

        // Prove the alias and password with `keytool -list -v` BEFORE copying anything.
        const probe: SigningConfig = { keystorePath: source, keyAlias: options.alias, storePassword, keyPassword };
        const sha = await readCertificateSha256(probe, { exec: exec(), env: env() });

        const target = keystorePath(paths());
        const existing = readSigningConfig(paths());
        if (existing?.certSha256 !== undefined && existing.certSha256 !== sha && resolve(target) !== source) {
          log(`⚠ Replacing the configured keystore (${existing.certSha256}) with another key (${sha}).`);
        }
        const path = resolve(target) === source ? target : importKeystoreFile(source, paths());
        writeSigningConfig({ ...probe, keystorePath: path, certSha256: sha }, paths());
        log(`Imported ${source} → ${path} (alias ${options.alias}).`);
        log(`SHA-256: ${sha}`);
        out(`${sha}\n`);
      }),
    );

  const existingPassword = async (name: string, question: string): Promise<string> => {
    const fromEnv = env()[name];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    if (ctx.promptSecret !== undefined || canPrompt()) {
      const answer = await promptSecret(question);
      if (answer !== '') return answer;
    }
    throw new UsageError(`Set ${name}, or run this in an interactive terminal to be asked.`);
  };

  keystore
    .command('show')
    .description('Print the keystore path, alias and certificate SHA-256')
    .action(
      action(async () => {
        const config = requireSigning(paths());
        const sha = await readCertificateSha256(config, { exec: exec(), env: env() });
        out(`keystore: ${config.keystorePath}\nalias:    ${config.keyAlias}\nsha256:   ${sha}\n`);
      }),
    );

  keystore
    .command('secrets')
    .description('Print the four GitHub Actions secrets for CI (#518) — the output CONTAINS SECRETS')
    .action(
      action(() => {
        const config = requireSigning(paths());
        log(
          'WARNING: the values below are your release signing credentials. Paste them into GitHub → Settings → ' +
            'Secrets and variables → Actions, then clear your terminal.\n',
        );
        for (const secret of githubSecrets(config)) out(`${secret.name}=${secret.value}\n`);
      }),
    );

  // ---- version ------------------------------------------------------------------
  android
    .command('version')
    .description('Show or change apps/android/version.properties (every change also increments versionCode)')
    .option('--bump <part>', 'patch, minor or major (versionCode += 1)')
    .option('--set <x.y.z>', 'Set versionName (versionCode += 1)')
    .option('--code <n>', 'Set versionCode explicitly (must increase)')
    .option('--json', 'Print { versionName, versionCode } as JSON')
    .action(
      action((options: { bump?: string; set?: string; code?: string; json?: boolean }) => {
        const root = requireRepoRoot(paths());
        const file = versionPropertiesPath(root);
        const current = readVersion(file);
        const next = applyVersionChange(current, {
          bump: options.bump === undefined ? undefined : parseBumpPart(options.bump),
          set: options.set,
          code: options.code === undefined ? undefined : parseCode(options.code),
        });
        if (next !== undefined) {
          writeVersion(file, next);
          log(current.exists ? `${versionLabel(current)} → ${versionLabel(next)}` : `Created ${file}`);
        } else if (!current.exists) {
          log(`${file} does not exist; showing the defaults.`);
        }
        const shown = next ?? current;
        out(
          options.json === true
            ? `${JSON.stringify({ versionName: shown.versionName, versionCode: shown.versionCode })}\n`
            : `${versionLabel(shown)}\n`,
        );
      }),
    );

  // ---- build ----------------------------------------------------------------------
  const doBuild = async (options: { serverUrl?: string; debug?: boolean }): Promise<BuildResult> => {
    const result = await runBuild(
      { serverUrl: options.serverUrl, debug: options.debug },
      { ...paths(), exec: exec(), platform: ctx.platform, log },
    );
    log(`APK:      ${result.apkPath} (${formatBytes(result.metadata.sizeBytes)})`);
    log(`Metadata: ${result.metadataPath}`);
    log(`Signer:   ${result.metadata.signingSha256}${result.verified ? ' (verified by apksigner)' : ''}`);
    return result;
  };

  android
    .command('build')
    .description('Build and sign the APK into dist/android/ with a sidecar metadata JSON')
    .option('--server-url <url>', 'Default server URL baked into the app')
    .option('--debug', 'Build the debug variant (debug-signed, package <id>.debug; not for publishing)')
    .action(
      action(async (options: { serverUrl?: string; debug?: boolean }) => {
        const result = await doBuild(options);
        out(`${result.apkPath}\n`);
      }),
    );

  // ---- publish --------------------------------------------------------------------
  const doPublish = async (
    apkPath: string,
    options: { notes?: string; current: boolean; force?: boolean },
    creds: ServerCredentials,
  ): Promise<AndroidRelease> => {
    const metadata = readBuiltApk(apkPath);
    log(`Uploading ${versionLabel(metadata)} to ${creds.serverUrl}…`);
    const release = await publishRelease(
      creds,
      apkPath,
      metadata,
      { notes: options.notes, makeCurrent: options.current, force: options.force === true },
      { fetch: ctx.fetch },
    );
    log(`Published ${versionLabel(release)}${release.isCurrent === true ? ' — now the current release' : ''}.`);
    log(`Release id: ${release.id}`);
    log(`Download page: ${downloadPageUrl(creds.serverUrl)}`);
    return release;
  };

  android
    .command('publish')
    .description('Upload a built APK (default: the newest in dist/android) to the logged-in server')
    .argument('[apk]', 'APK path; its sidecar .json must sit next to it')
    .option('--notes <text>', 'Release notes')
    .option('--no-current', 'Upload without making it the current release')
    .option('--force', 'Make it current even if its versionCode is not newer')
    .action(
      action(async (apk: string | undefined, options: { notes?: string; current: boolean; force?: boolean }) => {
        const path = apk !== undefined ? resolve(ctx.cwd ?? process.cwd(), apk) : newestApk(requireRepoRoot(paths()));
        readBuiltApk(path);
        const creds = requireLogin();
        await requirePublishPermission(client(creds), creds.serverUrl);
        const release = await doPublish(path, options, creds);
        out(`${release.id}\n`);
      }),
    );

  // ---- releases -------------------------------------------------------------------
  const releases = android
    .command('releases')
    .description('List the server\'s releases (current marked *); `releases current <id>` makes one current (rollback)')
    .option('--json', 'Print the releases as JSON')
    .action(
      action(async (options: { json?: boolean }) => {
        const list = await listReleases(client(requireLogin()));
        out(options.json === true ? `${JSON.stringify(list, null, 2)}\n` : formatReleasesTable(list));
      }),
    );

  releases
    .command('current')
    .description('Make a release current — the rollback; asks first when its versionCode is lower')
    .argument('<id>', 'Release id (see `memoriahub android releases`)')
    .option('-y, --yes', 'Do not ask, even for a rollback to a lower versionCode')
    .action(
      action(async (id: string, options: { yes?: boolean }) => {
        const creds = requireLogin();
        const api = client(creds);
        const list = await listReleases(api);
        const target = list.find((release) => release.id === id);
        if (target === undefined) throw new UsageError(`No release ${id} on ${creds.serverUrl}. See \`memoriahub android releases\`.`);
        const warning = rollbackWarning(target, list.find((release) => release.isCurrent === true));
        if (warning !== undefined && options.yes !== true) {
          log(`⚠ ${warning}`);
          const go = interactive() && (await confirm(`Make ${versionLabel(target)} current on ${creds.serverUrl}?`));
          if (!go) throw new UsageError(interactive() ? 'Cancelled.' : 'Rolling back to a lower versionCode needs --yes.');
        }
        const made = await makeCurrent(api, id);
        log(`${versionLabel(made)} is now the current release on ${creds.serverUrl}.`);
        out(`${made.id}\n`);
      }),
    );

  // ---- release (the one-command path) ---------------------------------------------
  android
    .command('release')
    .description('Pre-check, then bump → build → publish as current → commit version.properties')
    .option('--bump <part>', 'patch, minor or major (without it the current version is released if it is newer)')
    .option('--notes <text>', 'Release notes')
    .option('--server-url <url>', 'Default server URL baked into the app (default: the logged-in server)')
    .option('--no-commit', 'Do not commit version.properties')
    .action(
      action(async (options: { bump?: string; notes?: string; serverUrl?: string; commit: boolean }) => {
        const part: BumpPart | undefined = options.bump === undefined ? undefined : parseBumpPart(options.bump);
        const root = requireRepoRoot(paths());
        log('Pre-checks…');
        const plan = await releasePrechecks({
          repoRoot: root,
          packageName: readIdentity(root).applicationId,
          part,
          doctor: () => runAndroidDoctor({ ...paths(), exec: exec(), platform: ctx.platform }),
          credentials: requireLogin,
          requirePermission: (creds) => requirePublishPermission(client(creds), creds.serverUrl),
          latest: (creds) => latestRelease(client(creds)),
        });
        log(
          `  toolchain ok; ${plan.user.email ?? 'signed in'} can publish to ${plan.credentials.serverUrl}; ` +
            `server current: ${plan.current === null ? 'none' : versionLabel(plan.current)}; releasing ${versionLabel(plan.after)}.`,
        );

        const outcome = await runRelease<BuildResult, AndroidRelease>(
          plan,
          { commit: options.commit },
          {
            bump: () => bumpVersionFile(versionPropertiesPath(root), part as BumpPart).after,
            build: () => doBuild({ serverUrl: options.serverUrl ?? plan.credentials.serverUrl }),
            publish: (build) => doPublish(build.apkPath, { notes: options.notes, current: true }, plan.credentials),
            commit: (version) => commitVersionFile(exec(), root, version),
          },
          log,
        );
        log(`Commit: ${outcome.commit}`);
        out(`${versionLabel(outcome.version)}\n`);
      }),
    );

  return android;
}

function parseCode(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--code must be a whole number of at least 1 (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

function validatePassword(value: string): string {
  if (value.length < 6) throw new UsageError('keytool requires a keystore password of at least 6 characters.');
  return value;
}

/** The newest release APK (not `-debug.apk`) in dist/android. */
export function newestApk(repoRoot: string): string {
  const dir = distDir(repoRoot);
  const candidates = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.apk') && !name.endsWith('-debug.apk'))
        .map((name) => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    : [];
  const newest = candidates[0];
  if (newest === undefined) {
    throw new PreconditionError(`No APK in ${dir}. Build one with \`memoriahub android build\`.`);
  }
  return newest.path;
}

