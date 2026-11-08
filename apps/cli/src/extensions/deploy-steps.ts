import type { DeployStepContext, DeployStepRegistration } from '@marinoscar/platform-cli/deploy';

import {
  PGVECTOR_REMEDY,
  composeDirOf,
  composePrefix,
  pgvectorProbeArgv,
  readPgvectorVerdict,
} from './deployment.js';

// =============================================================================
// MemoriaHub's deploy steps  (issue #577, RETRO-F3; map: docs/platform-adoption/deploy-steps.md)
// =============================================================================
//
// The platform pipeline replaces `infra/deploy/{install,update}.sh`. Its steps
// cover what the scripts did (tools, checkout, `.env`, build, migrate, seed,
// start, health, host proxy). Two things are MemoriaHub's own:
//
//   database-extensions   before `migrate`: the database can install `vector`,
//                         so a missing extension is named before images are
//                         migrated instead of surfacing as a failed migration.
//   compreface-healthy    after the stack starts: the `compreface-core` sidecar
//                         that face detection calls is running. A warning, never
//                         a failure: face recognition is a feature flag, off by
//                         default, and the rest of the app does not need it.
//
// What needed no app step: `STACK_AGENT_TOKEN` / `DEPLOY_ROOT` (the platform's
// `environment` step generates them), the host port (`--port` writes
// `APP_BIND_PORT`), and the proxy vhost (platform `proxy-bootstrap` / `publish`).
// =============================================================================

type Exec = DeployStepContext['exec'];

/** Step id of the extension probe. */
export const DATABASE_EXTENSIONS_STEP = 'database-extensions';
/** Step id of the sidecar check. */
export const COMPREFACE_STEP = 'compreface-healthy';

/** Runs the probe through the context's `exec` and throws a clear error when `vector` is missing. */
export async function assertPgvectorAvailable(
  context: Pick<DeployStepContext, 'checkoutPath' | 'log' | 'exec'>,
): Promise<void> {
  const result = await context.exec(pgvectorProbeArgv(context.checkoutPath), {
    cwd: composeDirOf(context.checkoutPath),
    timeoutMs: 180_000,
    allowExitCodes: [0, 1, 2, 125, 126, 127],
  });
  const verdict = readPgvectorVerdict(result);
  if (verdict.status === 'present') {
    context.log('pgvector is available on the database server.');
    return;
  }
  if (verdict.status === 'absent') {
    throw new Error(`The database server does not offer the pgvector extension ("vector"). ${PGVECTOR_REMEDY}`);
  }
  // The probe itself failed (connection, image not built yet): do not block the
  // deploy on a guess. `migrate` fails with the database's own message if it matters.
  context.log(`Could not verify pgvector (${verdict.detail}); the migrations will report it if it is missing.`);
}

/** Warns, never throws, when the face sidecar is not among the running services. */
export async function reportCompreface(
  context: Pick<DeployStepContext, 'checkoutPath' | 'log' | 'exec'>,
): Promise<boolean> {
  try {
    const result = await context.exec(
      [...composePrefix(context.checkoutPath), 'ps', '--status', 'running', '--services'],
      { cwd: composeDirOf(context.checkoutPath), timeoutMs: 60_000, allowExitCodes: [0, 1] },
    );
    const running = result.stdout.split('\n').map((line) => line.trim());
    if (running.includes('compreface-core')) {
      context.log('compreface-core is running; face detection can reach it.');
      return true;
    }
    context.log(
      'compreface-core is not running. Face recognition (features.faceRecognition) needs it; ' +
        'leave the feature off or start the sidecar (infra/compose/app.compreface.compose.yml).',
    );
  } catch (error) {
    context.log(`Could not inspect compreface-core: ${error instanceof Error ? error.message : String(error)}`);
  }
  return false;
}

function databaseExtensions(pipeline: 'install' | 'update'): DeployStepRegistration {
  return {
    pipeline,
    id: DATABASE_EXTENSIONS_STEP,
    before: 'migrate',
    step: {
      title: 'Verify the database offers pgvector',
      run: (context) => assertPgvectorAvailable(context),
    },
  };
}

function comprefaceHealthy(pipeline: 'install' | 'update', after: string): DeployStepRegistration {
  return {
    pipeline,
    id: COMPREFACE_STEP,
    after,
    step: {
      title: 'Check the compreface-core sidecar',
      run: async (context) => {
        await reportCompreface(context);
      },
    },
  };
}

/** Every app step, in registration order; `createCli({ deploySteps })` takes this list. */
export const APP_DEPLOY_STEPS: readonly DeployStepRegistration[] = Object.freeze([
  databaseExtensions('install'),
  databaseExtensions('update'),
  comprefaceHealthy('install', 'start'),
  comprefaceHealthy('update', 'restart'),
]);

export type { Exec };
