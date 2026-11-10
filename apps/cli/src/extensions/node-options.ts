/**
 * extensions/node-options.ts - the 1.3 `node` flags the platform group does not declare
 * (RETRO-C10, #616), attached to the platform commands and mapped onto what the engine reads.
 *
 *   node register|start   --compreface-url <url>   -> MEMORIAHUB_COMPREFACE_URL
 *   node register|start   --face-provider <p>      -> refused unless `compreface` (the only provider)
 *   node start            --poll <ms>              -> MEMORIAHUB_POLL_INTERVAL_MS
 *   node start            --concurrency, --types   -> MEMORIAHUB_CONCURRENCY, MEMORIAHUB_ELIGIBLE_TYPES
 *   node install-deps     --skip-compreface, --compreface-port|processes|memory|cpus|recreate
 *                         (and the 1.3 short forms --memory, --cpus)
 *
 * Each is set in a `preAction` hook, before the platform action reads its configuration.
 */

import { workerEnv } from '@marinoscar/platform-cli/node';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';
import type { Command } from 'commander';

import { comprefaceInstallOptions } from '../executors/install-steps.js';
import { appWorkerEnv } from '../worker-env.js';

function child(parent: Command | undefined, name: string): Command | undefined {
  return parent?.commands.find((c) => c.name() === name);
}

export const APP_NODE_OPTIONS: CliCommandRegistration = (program: Command) => {
  const node = child(program, 'node');
  const register = child(node, 'register');
  const start = child(node, 'start');
  const install = child(node, 'install-deps');

  for (const cmd of [register, start]) {
    cmd?.option('--compreface-url <url>', 'Base URL of the compreface-core sidecar');
    cmd?.option('--face-provider <provider>', 'Face provider (only "compreface" is supported)');
  }
  start?.option('--poll <ms>', 'Idle poll interval in milliseconds');
  start?.option('-c, --concurrency <n>', 'How many jobs to run at once');
  start?.option('-t, --types <csv>', 'Comma-separated job types to claim');

  for (const cmd of [register, start]) {
    cmd?.hook('preAction', (_this, action) => {
      const opts = action.opts() as { comprefaceUrl?: string; faceProvider?: string; poll?: string; concurrency?: string; types?: string };
      if (opts.faceProvider !== undefined && opts.faceProvider !== 'compreface') {
        throw new Error(`--face-provider ${opts.faceProvider} is not supported: CompreFace is the only face provider.`);
      }
      if (opts.comprefaceUrl !== undefined) process.env[appWorkerEnv.comprefaceUrl] = opts.comprefaceUrl;
      if (opts.poll !== undefined) process.env[workerEnv().pollMs] = opts.poll;
      if (opts.concurrency !== undefined) process.env[workerEnv().concurrency] = opts.concurrency;
      if (opts.types !== undefined) process.env[workerEnv().types] = opts.types;
    });
  }

  if (install) {
    install
      .option('--skip-compreface', 'Do not set up the CompreFace container')
      .option('--compreface-port <port>', 'Host port for the CompreFace container', '3000')
      .option('--compreface-processes <n>', 'uwsgi processes in the CompreFace container')
      .option('--compreface-memory <size>', 'Memory cap for the CompreFace container (docker --memory)')
      .option('--compreface-cpus <n>', 'CPU cap for the CompreFace container (docker --cpus)')
      .option('--compreface-recreate', 'Recreate a running CompreFace container with the new settings')
      .option('--memory <size>', 'Alias of --compreface-memory')
      .option('--cpus <n>', 'Alias of --compreface-cpus');
    install.hook('preAction', (_this, action) => {
      const o = action.opts() as Record<string, string | boolean | undefined>;
      comprefaceInstallOptions.skip = o['skipCompreface'] === true;
      comprefaceInstallOptions.port = Number(o['comprefacePort'] ?? 3000) || 3000;
      const processes = Number(o['comprefaceProcesses']);
      if (Number.isFinite(processes) && processes > 0) comprefaceInstallOptions.processes = Math.floor(processes);
      const memory = (o['comprefaceMemory'] ?? o['memory']) as string | undefined;
      const cpus = (o['comprefaceCpus'] ?? o['cpus']) as string | undefined;
      if (memory) comprefaceInstallOptions.memory = memory;
      if (cpus) comprefaceInstallOptions.cpus = cpus;
      comprefaceInstallOptions.recreate = o['comprefaceRecreate'] === true;
    });
  }
};
