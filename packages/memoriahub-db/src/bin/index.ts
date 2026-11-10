import { Command, CommanderError, Option } from 'commander';
import { resolve } from 'node:path';

import { MemoriahubCheckUsageError, checkMemoriahubInstall } from '../check/index.js';
import { MemoriahubLockError } from '../lock/index.js';
import { promoteMemoriahubMigration } from '../promote/index.js';
import { MemoriahubSyncError, applyMemoriahubSync, planMemoriahubSync, type MemoriahubNamePolicy } from '../sync/index.js';

/**
 * Where the `memoriahub-db` command writes: two functions, one per stream.
 *
 * @stability experimental
 */
export interface MemoriahubDbIo {
  /** Writes text to standard output. */
  out(text: string): void;
  /** Writes text to standard error. */
  err(text: string): void;
}

/**
 * The commands `memoriahub-db` runs.
 *
 * @stability experimental
 */
export const MEMORIAHUB_DB_COMMANDS: readonly string[] = ['sync', 'check', 'promote'];

/**
 * The environment and working directory a run reads; defaults to the process's.
 *
 * @stability experimental
 */
export interface MemoriahubDbContext {
  /** The environment (`DATABASE_URL` for `check --database`). */
  env: NodeJS.ProcessEnv;
  /** The directory `--root` defaults to. */
  cwd: string;
  /** The package folder to read and write (tests); defaults to the installed package. */
  packageDir?: string;
}

function buildProgram(io: MemoriahubDbIo, context: MemoriahubDbContext, setExit: (code: number) => void): Command {
  const program = new Command('memoriahub-db');
  program
    .description(
      'Installs the MemoriaHub domain schema fragments and migrations into an app, and checks that the installed copies match the package.\n' +
        'Exit codes: 0 ok, 1 failed check or refusal, 2 usage error or missing DATABASE_URL.',
    )
    .exitOverride()
    .configureOutput({ writeOut: (text) => io.out(text), writeErr: (text) => io.err(text) });

  const guarded = async (body: () => Promise<number> | number): Promise<void> => {
    try {
      setExit(await body());
    } catch (error) {
      if (error instanceof MemoriahubCheckUsageError) {
        io.err(`memoriahub-db: ${error.message}\n`);
        setExit(2);
      } else if (error instanceof MemoriahubSyncError || error instanceof MemoriahubLockError) {
        io.err(`memoriahub-db: ${error.message}\n`);
        setExit(1);
      } else {
        throw error;
      }
    }
  };
  const rootOf = (value: string | undefined) => resolve(context.cwd, value ?? '.');

  program
    .command('sync')
    .description('Copy the domain fragments and migrations into the app, write prisma/memoriahub.lock and merge the raw-SQL indexes into prisma/platform.lock.')
    .option('--root <dir>', 'the app folder that holds prisma/ (default: the current directory)')
    .option('--fragments <dir>', "the package's fragment folder to install from (default: the package's schema/)")
    .option('--migrations <dir>', "the package's migrations folder to install from (default: the package's migrations/)")
    .addOption(new Option('--names <policy>', 'directory names for newly installed migrations: original, stable (the package timestamp, memoriahub_ and the slug), or after-host (deprecated) (default: original when the app already has memoriahub history under original names, the lock\'s policy when it has a lock, else stable)').choices(['original', 'stable', 'after-host']))
    .addOption(new Option('--baseline <mode>', 'the baseline migration (the whole domain schema, for a host with no history): auto adopts it when the host already holds the migration the manifest names, else installs it; adopt or install force one (default: auto)').choices(['auto', 'adopt', 'install']))
    .option('--dry-run', 'print what would change; write nothing')
    .action((options: { root?: string; fragments?: string; migrations?: string; names?: MemoriahubNamePolicy; baseline?: 'auto' | 'adopt' | 'install'; dryRun?: boolean }) =>
      guarded(() => {
        const plan = planMemoriahubSync({
          root: rootOf(options.root),
          ...(options.fragments ? { fragmentsDir: resolve(context.cwd, options.fragments) } : {}),
          ...(options.migrations ? { migrationsDir: resolve(context.cwd, options.migrations) } : {}),
          ...(options.names ? { names: options.names } : {}),
          ...(options.baseline ? { baseline: options.baseline } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(context.packageDir ? { packageDir: context.packageDir } : {}),
        });
        for (const line of plan.messages) io.out(`memoriahub-db sync: ${options.dryRun ? '(dry run) ' : ''}${line}\n`);
        applyMemoriahubSync(plan);
        return 0;
      }),
    );

  program
    .command('check')
    .description('Prove the installed fragments and migrations are byte-identical to the package; with --database also check a live database.')
    .option('--root <dir>', 'the app folder that holds prisma/ (default: the current directory)')
    .option('--database', 'also check the extensions, raw-SQL indexes, generated columns, CHECK constraints, function and triggers in the database named by DATABASE_URL')
    .action((options: { root?: string; database?: boolean }) =>
      guarded(async () => {
        const result = await checkMemoriahubInstall({
          root: rootOf(options.root),
          ...(options.database ? { database: true, databaseUrl: context.env.DATABASE_URL ?? '' } : {}),
          ...(context.packageDir ? { packageDir: context.packageDir } : {}),
        });
        for (const problem of result.problems) io.err(`${problem.code}  ${problem.message}\n`);
        const label = options.database ? 'memoriahub-db check --database' : 'memoriahub-db check';
        if (!result.ok) {
          io.err(`${label}: ${result.problems.length} problem(s)\n`);
          return 1;
        }
        io.out(`${label}: ok (${result.notes.join('; ')})\n`);
        return 0;
      }),
    );

  program
    .command('promote')
    .description('Move a migration authored in the app with `prisma migrate dev --create-only` into the package, then install it under its original name.')
    .argument('<localDir>', 'the directory under prisma/migrations the draft was created in')
    .requiredOption('--id <slug>', 'snake_case slug of the package id (the draft timestamp is kept)')
    .requiredOption('--slice <slice>', 'the domain slice that owns it (a schema/memoriahub.<slice>.prisma fragment of the package)')
    .option('--root <dir>', 'the app folder that holds prisma/ (default: the current directory)')
    .action((localDir: string, options: { id: string; slice: string; root?: string }) =>
      guarded(() => {
        const result = promoteMemoriahubMigration({
          root: rootOf(options.root),
          localDir,
          id: options.id,
          slice: options.slice,
          ...(context.packageDir ? { packageDir: context.packageDir } : {}),
        });
        io.out(`memoriahub-db promote: ${localDir} -> memoriahub:${result.id} (requires ${result.requiresHostTables.join(', ') || 'no host table'})\n`);
        for (const warning of result.warnings) io.err(`memoriahub-db promote: ${warning}\n`);
        io.out('commit both trees: packages/memoriahub-db/migrations/**, the app copy, prisma/memoriahub.lock and a changeset\n');
        return 0;
      }),
    );

  return program;
}

/**
 * The usage text of the `memoriahub-db` command.
 *
 * @returns The text `memoriahub-db --help` prints, ending with a newline.
 * @stability experimental
 */
export function memoriahubDbUsage(): string {
  const program = buildProgram({ out: () => undefined, err: () => undefined }, { env: {}, cwd: '.' }, () => undefined);
  return program.helpInformation();
}

/**
 * Runs the `memoriahub-db` command.
 *
 * @param argv - The arguments after the command name.
 * @param io - Where to write.
 * @param context - The environment and working directory; defaults to the process's.
 * @returns The process exit code: 0 ok (also for `--help` and no arguments), 1 a failed check or a refusal, 2 a usage error or a missing `DATABASE_URL`.
 * @stability experimental
 */
export async function runMemoriahubDb(
  argv: readonly string[],
  io: MemoriahubDbIo,
  context: MemoriahubDbContext = { env: process.env, cwd: process.cwd() },
): Promise<number> {
  if (argv.length === 0) {
    io.out(memoriahubDbUsage());
    return 0;
  }
  let exit = 0;
  const program = buildProgram(io, context, (code) => {
    exit = code;
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    throw error;
  }
  return exit;
}
