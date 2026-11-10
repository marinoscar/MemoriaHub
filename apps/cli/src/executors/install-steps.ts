/**
 * executors/install-steps.ts - what `memoriahub node install-deps` adds to the platform's steps
 * (RETRO-C10, #616). Each step is idempotent: `detect` says whether it is satisfied.
 *
 *   ffmpeg        apt `ffmpeg` (ffprobe ships with it)                       Debian family, sudo
 *   native-libs   sharp / onnxruntime-node resolve (npm optionalDependencies)  detect only
 *   tesseract     OCR language data for social_media_detection Tier 2         best-effort download
 *   compreface    the compreface-core sidecar container                       only where docker exists
 *
 * Docker itself is not installed by this command any more: install it first (docs/worker-node-setup.md).
 */

import {
  ensureAptPackages,
  ensureDockerContainer,
  registerInstallStep,
  type InstallContext,
} from '@marinoscar/platform-cli/node';
import * as os from 'node:os';
import * as path from 'node:path';

import { comprefaceUrl, isModuleInstalled, NATIVE_MODULES } from './support.js';
import { resolveModelsDirectory } from './models.js';

export const COMPREFACE_IMAGE = 'exadel/compreface-core:1.2.0-mobilenet';
export const COMPREFACE_CONTAINER_NAME = 'memoriahub-compreface-core';

/** `UWSGI_PROCESSES`: cores minus two for the node and the OS, between 1 and 6. */
export function defaultComprefaceProcesses(cores: number = os.availableParallelism?.() ?? os.cpus().length): number {
  return Math.min(Math.max(cores - 2, 1), 6);
}

async function tryCapture(context: InstallContext, command: string, args: string[]): Promise<boolean> {
  try {
    await context.capture(command, args);
    return true;
  } catch {
    return false;
  }
}

/** What `node install-deps --compreface-*` set for this run (see extensions/node-options.ts). */
export const comprefaceInstallOptions: {
  skip: boolean;
  port: number;
  processes?: number;
  memory?: string;
  cpus?: string;
  recreate: boolean;
} = { skip: false, port: 3000, recreate: false };

let registered = false;

/** @internal */
export function resetInstallStepsForTests(): void {
  registered = false;
}

/** Registers the steps once. */
export function registerInstallSteps(): void {
  if (registered) return;
  registered = true;

  registerInstallStep({
    id: 'ffmpeg',
    label: 'ffmpeg and ffprobe',
    requiresSudo: true,
    supported: (context) => context.distro.family === 'debian',
    detect: async (context) =>
      (await tryCapture(context, 'ffmpeg', ['-version'])) && (await tryCapture(context, 'ffprobe', ['-version'])),
    install: async (context) => {
      await ensureAptPackages(['ffmpeg'], context);
    },
  });

  registerInstallStep({
    id: 'native-libs',
    label: 'Native compute libraries (sharp, onnxruntime-node)',
    supported: () => true,
    detect: () => isModuleInstalled(NATIVE_MODULES['sharp'] as string) && isModuleInstalled(NATIVE_MODULES['onnxruntime'] as string),
    install: () => {
      throw new Error(
        'sharp or onnxruntime-node is not installed. They are optional dependencies of the CLI: reinstall it with ' +
          '`npm install -g @memoriahub/cli` (or `npm rebuild`) on a machine with a build toolchain; see docs/worker-node-setup.md.',
      );
    },
  });

  registerInstallStep({
    id: 'tesseract',
    label: 'Tesseract OCR language data',
    supported: () => isModuleInstalled(NATIVE_MODULES['tesseract'] as string),
    detect: async () => {
      const fs = await import('node:fs');
      const dir = path.join(resolveModelsDirectory(), 'tesseract');
      return fs.existsSync(path.join(dir, 'eng.traineddata.gz')) || fs.existsSync(path.join(dir, 'eng.traineddata'));
    },
    install: async (context) => {
      const { createOcrEngine } = await import('@marinoscar/memoriahub-compute/ocr');
      const engine = await createOcrEngine({ langDir: path.join(resolveModelsDirectory(), 'tesseract'), languages: ['eng'] });
      await engine.terminate();
      context.log('Tesseract language data downloaded.');
    },
  });

  registerInstallStep({
    id: 'compreface',
    label: 'CompreFace face-detection sidecar (docker)',
    requiresSudo: false,
    supported: (context) => !comprefaceInstallOptions.skip && tryCapture(context, 'docker', ['--version']),
    detect: async () => {
      if (comprefaceInstallOptions.recreate) return false;
      try {
        const res = await fetch(`${comprefaceUrl().replace(/\/$/, '')}/status`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch {
        return false;
      }
    },
    install: async (context) => {
      await ensureDockerContainer(
        {
          name: COMPREFACE_CONTAINER_NAME,
          image: COMPREFACE_IMAGE,
          args: [
            '-p',
            `${comprefaceInstallOptions.port}:3000`,
            '-e',
            `UWSGI_PROCESSES=${comprefaceInstallOptions.processes ?? defaultComprefaceProcesses()}`,
            '-e',
            'UWSGI_THREADS=1',
            ...(comprefaceInstallOptions.memory ? ['--memory', comprefaceInstallOptions.memory] : []),
            ...(comprefaceInstallOptions.cpus ? ['--cpus', comprefaceInstallOptions.cpus] : []),
          ],
          verify: async () => {
            try {
              return (await fetch(`http://localhost:${comprefaceInstallOptions.port}/status`, { signal: AbortSignal.timeout(3000) })).ok;
            } catch {
              return false;
            }
          },
        },
        context,
      );
    },
  });
}
