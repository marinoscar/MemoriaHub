import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { DeployCheck, DeployCheckContext, DeployCheckResult } from '@marinoscar/platform-cli/deploy';

import {
  PGVECTOR_REMEDY,
  composeDirOf,
  pgvectorProbeArgv,
  readPgvectorVerdict,
} from './deployment.js';

// =============================================================================
// MemoriaHub's deploy checks  (issue #577, RETRO-F3)
// =============================================================================
//
//   pgvector-available  (required)     the database server offers the `vector` extension
//   models-dir          (recommended)  the model volume overlay and MODELS_DIR are sane
//
// `deploy doctor` runs them; the install/update preflight runs them too. Both
// need a checkout, so on a host that has none yet (a first install, before
// `checkout`) they SKIP rather than guess: the `database-extensions` step
// repeats the pgvector probe right before the migrations.
// =============================================================================

/** Runs argv in cwd; resolves with the outcome, never rejects. Seam for tests. */
export type CommandProbe = (
  argv: readonly string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const probeCommand: CommandProbe = (argv, cwd) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    execFile(file as string, args, { cwd, timeout: 180_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 1;
      resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

function checkoutOf(context: DeployCheckContext): string {
  return join(context.deployRoot, 'repo');
}

/** Builds the `pgvector-available` check; the command runner is a seam for the tests. */
export function createPgvectorCheck(run: CommandProbe = probeCommand, fileExists: (p: string) => boolean = existsSync): DeployCheck {
  return {
    id: 'pgvector-available',
    title: 'Database offers pgvector',
    severity: 'required',
    requires: ['docker-daemon', 'docker-compose-v2'],
    async run(context): Promise<DeployCheckResult> {
      const checkout = checkoutOf(context);
      if (!fileExists(join(composeDirOf(checkout), '.env'))) {
        return {
          status: 'skip',
          detail: 'no environment file yet; the database-extensions step checks before the migrations',
        };
      }
      const result = await run(pgvectorProbeArgv(checkout), composeDirOf(checkout));
      const verdict = readPgvectorVerdict(result);
      if (verdict.status === 'present') return { status: 'pass', detail: 'the vector extension is available' };
      if (verdict.status === 'absent') {
        return { status: 'fail', detail: 'the vector extension is not available on the database server', remedy: PGVECTOR_REMEDY };
      }
      return {
        status: 'warn',
        detail: `could not verify pgvector: ${verdict.detail}`,
        remedy: 'Build the images and check the POSTGRES_* settings, then run deploy doctor again.',
      };
    },
  };
}

/** Builds the `models-dir` check. */
export function createModelsDirCheck(fileExists: (p: string) => boolean = existsSync): DeployCheck {
  return {
    id: 'models-dir',
    title: 'Enrichment model storage',
    severity: 'recommended',
    async run(context): Promise<DeployCheckResult> {
      const configured = context.env?.get('MODELS_DIR');
      if (configured !== undefined && configured !== '' && !configured.startsWith('/')) {
        return {
          status: 'warn',
          detail: `MODELS_DIR=${configured} is relative`,
          remedy: 'Leave MODELS_DIR unset (the persistent models volume is used) or set an absolute path inside the container.',
        };
      }
      const overlay = join(composeDirOf(checkoutOf(context)), 'app.models-volume.compose.yml');
      if (!fileExists(composeDirOf(checkoutOf(context)))) {
        return { status: 'skip', detail: 'no checkout yet' };
      }
      return fileExists(overlay)
        ? { status: 'pass', detail: 'models volume overlay present; the CLIP model survives container recreation' }
        : {
            status: 'warn',
            detail: 'app.models-volume.compose.yml is missing',
            remedy: 'Without the volume the duplicate-detection model is downloaded again after every rebuild.',
          };
    },
  };
}

/** Every app check; `createCli({ deployChecks })` takes this list. */
export const APP_DEPLOY_CHECKS: readonly DeployCheck[] = Object.freeze([createPgvectorCheck(), createModelsDirCheck()]);
