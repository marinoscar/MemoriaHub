/**
 * node/install-deps.ts — `memoriahub node install-deps` orchestration steps.
 *
 * Automates installing every dependency a Linux machine needs to become a
 * fully-operational worker node: ffmpeg/ffprobe, the npm native compute
 * libraries (sharp, onnxruntime-node, @vladmandic/human + TensorFlow.js
 * backends, tesseract.js), the tesseract OCR language data, Docker, and the
 * local compreface-core sidecar container.
 *
 * Every step function here CHECKS first and only acts if something is
 * missing/broken, returning a structured {@link InstallStepResult} so the
 * orchestrating command (commands/node.ts's `installDepsCmd()`) can print a
 * clear per-step report and compute an overall pass/fail exit code. This
 * module is deliberately headless — no Ink/TUI import — because several
 * steps here run privileged system commands (apt-get, docker) via `sudo`,
 * which is exactly the kind of process-interop hazard that breaks Ink's
 * render loop (see tui/NodeService.tsx's header comment on why
 * `spawnSync(...,{stdio:'inherit'})` must never be used inside a TUI screen).
 *
 * Every command that requires `sudo` is announced on stdout BEFORE it runs
 * (see {@link runWithSudoAnnounced}) — this is a hard requirement: no
 * privileged action in this module is ever silent.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { createOcrEngine } from '@memoriahub/enrichment-compute/ocr';

import { ui } from '../ui.js';
import { loadConfig } from '../config.js';
import { ApiClient } from '../api.js';
import {
  detectCapabilities,
  NATIVE_MODULES,
  type CapabilityStatus,
} from './capabilities.js';
import { tesseractLangDir, testCompreface } from './self-test.js';
import { ensureModels } from './models.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type InstallStepStatus = 'skipped' | 'installed' | 'failed' | 'unsupported';

export interface InstallStepResult {
  /** Human label, e.g. "ffmpeg/ffprobe". */
  step: string;
  status: InstallStepStatus;
  /** What happened / why. */
  detail: string;
  /**
   * True only for the Docker-install step when this run just added the
   * current user to the `docker` group — group membership does not apply
   * retroactively to an already-running process, so the caller should warn
   * the user to log out/in (or `newgrp docker`) before a subsequent PLAIN
   * `docker` command reflects it. This run itself is unaffected because
   * every docker invocation in this module always goes through `sudo`
   * (see {@link ensureDocker}'s docstring for the rationale).
   */
  requiresRelogin?: boolean;
}

// ---------------------------------------------------------------------------
// Low-level process helpers
// ---------------------------------------------------------------------------

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a command to completion via `child_process.spawn`, collecting
 * stdout/stderr and never throwing — spawn errors (e.g. ENOENT) resolve with
 * `code: null` and a descriptive stderr instead of rejecting, so callers can
 * treat every outcome uniformly. Deliberately NOT `execSync` — some of the
 * commands this drives (apt-get, docker pull, npm install) can run for
 * minutes, and a synchronous call would block the whole CLI process.
 */
function runProcess(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts?.cwd,
        env: opts?.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      resolve({ code: null, stdout, stderr: stderr || (err instanceof Error ? err.message : String(err)) });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** True when `bin` resolves on PATH via `which`. */
async function commandExists(bin: string): Promise<boolean> {
  const res = await runProcess('which', [bin]);
  return res.code === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Race an async operation against a timeout, converting a timeout into a rejection. */
async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Root / distro detection
// ---------------------------------------------------------------------------

/** True when the current process is running as root (uid 0). */
export function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Coarse Linux distro family, parsed from /etc/os-release. */
export function detectLinuxDistro(): { family: 'debian' | 'other'; prettyName: string } {
  let content: string;
  try {
    content = fs.readFileSync('/etc/os-release', 'utf8');
  } catch {
    return { family: 'other', prettyName: 'Unknown (no /etc/os-release)' };
  }

  const fields: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const m = /^([A-Za-z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1] as string;
    let value = (m[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const id = (fields['ID'] ?? '').toLowerCase();
  const idLike = (fields['ID_LIKE'] ?? '').toLowerCase();
  const prettyName = fields['PRETTY_NAME'] || id || 'Unknown Linux';
  const isDebianFamily =
    id === 'debian' || id === 'ubuntu' || idLike.includes('debian') || idLike.includes('ubuntu');

  return { family: isDebianFamily ? 'debian' : 'other', prettyName };
}

// ---------------------------------------------------------------------------
// Privileged command runner — every sudo-requiring action goes through this
// ---------------------------------------------------------------------------

/**
 * Run a system command, prefixing it with `sudo` unless the current process
 * is already root. Every sudo invocation is announced on stdout BEFORE it
 * runs — this is a hard, explicit requirement: no privileged action in this
 * module is ever silent.
 *
 * `opts.dryRun` prints the announcement but does NOT execute anything —
 * useful for `--dry-run` on the orchestrating command.
 */
export async function runWithSudoAnnounced(
  cmd: string,
  args: string[],
  opts?: { dryRun?: boolean },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const root = isRoot();
  const announced = root ? `${cmd} ${args.join(' ')}`.trim() : `sudo ${cmd} ${args.join(' ')}`.trim();

  // Dry run short-circuits BEFORE any process is spawned — including the
  // sudo-presence probe below — so `--dry-run` never touches the system at
  // all, only ever announcing what it would have done.
  if (opts?.dryRun) {
    if (!root) {
      ui.warn(`Running with sudo (you may be prompted for your password): ${announced}`);
    } else {
      ui.dim(`Running as root: ${announced}`);
    }
    return { ok: true, stdout: '(dry run — not executed)', stderr: '' };
  }

  let execCmd = cmd;
  let execArgs = args;
  if (!root) {
    const sudoAvailable = await commandExists('sudo');
    if (!sudoAvailable) {
      return {
        ok: false,
        stdout: '',
        stderr: 'sudo is not available and you are not root; install sudo or re-run as root.',
      };
    }
    execCmd = 'sudo';
    execArgs = [cmd, ...args];
  }

  if (!root) {
    ui.warn(`Running with sudo (you may be prompted for your password): ${announced}`);
  } else {
    ui.dim(`Running as root: ${announced}`);
  }

  const res = await runProcess(execCmd, execArgs);
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
}

/** Install one or more apt packages (update then install -y), debian/ubuntu only. */
export async function ensureAptPackages(
  packages: string[],
  opts?: { dryRun?: boolean },
): Promise<InstallStepResult> {
  const step = `apt packages (${packages.join(', ')})`;
  const distro = detectLinuxDistro();
  if (distro.family !== 'debian') {
    return {
      step,
      status: 'unsupported',
      detail: `Automated package install is only supported on apt-based distros today (detected: ${distro.prettyName}).`,
    };
  }

  const update = await runWithSudoAnnounced('apt-get', ['update'], opts);
  if (!update.ok) {
    return {
      step,
      status: 'failed',
      detail: `apt-get update failed: ${update.stderr || update.stdout || '(no output)'}`,
    };
  }

  const install = await runWithSudoAnnounced('apt-get', ['install', '-y', ...packages], opts);
  if (!install.ok) {
    return {
      step,
      status: 'failed',
      detail: `apt-get install failed: ${install.stderr || install.stdout || '(no output)'}`,
    };
  }

  return { step, status: 'installed', detail: `Installed via apt-get: ${packages.join(', ')}` };
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe
// ---------------------------------------------------------------------------

export async function ensureFfmpeg(
  caps: Record<string, CapabilityStatus>,
  opts?: { dryRun?: boolean },
): Promise<InstallStepResult> {
  const step = 'ffmpeg/ffprobe';
  if (caps['ffmpeg']?.available && caps['ffprobe']?.available) {
    return { step, status: 'skipped', detail: 'ffmpeg and ffprobe are already available on PATH.' };
  }

  const distro = detectLinuxDistro();
  if (distro.family !== 'debian') {
    return {
      step,
      status: 'unsupported',
      detail:
        'Automated ffmpeg install is only supported on apt-based distros today — see ' +
        'docs/worker-node-setup.md §2 for manual per-distro instructions.',
    };
  }

  const aptResult = await ensureAptPackages(['ffmpeg'], opts);
  if (aptResult.status !== 'installed') {
    return { step, status: aptResult.status, detail: aptResult.detail };
  }
  if (opts?.dryRun) {
    return { step, status: 'installed', detail: 'Dry run — would install ffmpeg via apt-get.' };
  }

  const after = await detectCapabilities();
  if (after['ffmpeg']?.available && after['ffprobe']?.available) {
    return { step, status: 'installed', detail: 'Installed ffmpeg via apt-get.' };
  }
  return {
    step,
    status: 'failed',
    detail: 'apt-get reported success, but ffmpeg/ffprobe are still not on PATH.',
  };
}

// ---------------------------------------------------------------------------
// npm native compute dependencies (sharp / onnxruntime / tfjs / human / tesseract)
// ---------------------------------------------------------------------------

export async function ensureNpmNativeDeps(
  cliInstallDir: string,
  caps: Record<string, CapabilityStatus>,
  opts?: { dryRun?: boolean },
): Promise<InstallStepResult> {
  const step = 'npm native compute dependencies';
  const nativeKeys = Object.keys(NATIVE_MODULES);
  const missingBefore = nativeKeys.filter((k) => !caps[k]?.available);

  if (missingBefore.length === 0) {
    return { step, status: 'skipped', detail: 'All native compute libraries are already installed.' };
  }

  if (opts?.dryRun) {
    return {
      step,
      status: 'skipped',
      detail: `Dry run — would run \`npm install\` in ${cliInstallDir} for: ${missingBefore.join(', ')}.`,
    };
  }

  ui.step(`Installing npm dependencies in ${cliInstallDir} (missing: ${missingBefore.join(', ')})…`);
  const install1 = await runProcess('npm', ['install'], { cwd: cliInstallDir });

  let after = await detectCapabilities();
  let stillMissing = nativeKeys.filter((k) => !after[k]?.available);
  if (stillMissing.length === 0) {
    return { step, status: 'installed', detail: `Installed via npm install: ${missingBefore.join(', ')}.` };
  }

  // Remediation ladder (mirrors install.sh's documented remediation): if a
  // module is still missing after a plain `npm install`, check for a C
  // toolchain and, on apt-based systems, install it, then retry once with
  // npm_config_build_from_source=true forcing a from-source rebuild.
  const [gcc, python3] = await Promise.all([commandExists('gcc'), commandExists('python3')]);
  const toolchainMissing = !gcc || !python3;

  const distro = detectLinuxDistro();
  if (toolchainMissing && distro.family === 'debian') {
    const toolchainResult = await ensureAptPackages(['build-essential', 'python3']);
    if (toolchainResult.status === 'failed') {
      return {
        step,
        status: 'failed',
        detail:
          `Still missing after npm install: ${stillMissing.join(', ')}. ` +
          `Toolchain install also failed: ${toolchainResult.detail}`,
      };
    }
  }

  const install2 = await runProcess('npm', ['install'], {
    cwd: cliInstallDir,
    env: { ...process.env, npm_config_build_from_source: 'true' },
  });

  after = await detectCapabilities();
  stillMissing = nativeKeys.filter((k) => !after[k]?.available);
  if (stillMissing.length === 0) {
    return {
      step,
      status: 'installed',
      detail: `Installed via npm install (source-build fallback): ${missingBefore.join(', ')}.`,
    };
  }

  const lastStderr = (install2.stderr || install1.stderr || '').slice(-800);
  return {
    step,
    status: 'failed',
    detail:
      `Still missing after all remediation attempts: ${stillMissing.join(', ')}. ` +
      `Last npm install output: ${lastStderr || '(no output captured)'}`,
  };
}

// ---------------------------------------------------------------------------
// tesseract OCR language data
// ---------------------------------------------------------------------------

const TESSERACT_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * For tesseract specifically, "check" and "install if missing" are the SAME
 * operation: `createOcrEngine()` deliberately leaves `langPath` unset when
 * the language's traineddata isn't already on disk, which makes
 * tesseract.js's own `createWorker()` call download it from tesseract.js's
 * default CDN as a side effect of just constructing the worker — before any
 * `recognize()` call. See packages/enrichment-compute/src/ocr/index.ts.
 *
 * `caps` here is expected to be the OPERATIONAL capability map (post
 * self-test), not mere presence — a `tesseract.available: true` entry means
 * the self-test already proved language data is present and usable, so we
 * skip. Otherwise we call the same two operations `testTesseract()` already
 * does (create the engine, terminate it), but WITHOUT the "only if already
 * present" gate that self-test applies — this function's entire point is to
 * trigger the download when it's missing.
 */
export async function ensureTesseractLanguageData(
  caps: Record<string, CapabilityStatus>,
  languages: string[] = ['eng'],
): Promise<InstallStepResult> {
  const step = 'Tesseract OCR language data';
  if (caps['tesseract']?.available) {
    return { step, status: 'skipped', detail: caps['tesseract'].detail ?? 'tesseract already operational.' };
  }

  const langDir = tesseractLangDir();
  try {
    const engine = await withTimeout(
      () => createOcrEngine({ langDir, languages }),
      TESSERACT_DOWNLOAD_TIMEOUT_MS,
      'tesseract language data download',
    );
    await engine.terminate();
    return {
      step,
      status: 'installed',
      detail: `Downloaded/cached tesseract language data (${languages.join('+')}) at ${langDir}.`,
    };
  } catch (err) {
    return {
      step,
      status: 'failed',
      detail: `Failed to install tesseract language data: ${errMsg(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

/**
 * Ensure Docker is installed and the daemon is actually running.
 *
 * Every docker invocation in this module — including this presence/health
 * check — is routed through {@link runWithSudoAnnounced} unconditionally.
 * Simpler and more robust than trying to detect whether the current process
 * has picked up a just-added `docker` group membership (it never does,
 * within the same process — group membership doesn't apply retroactively):
 * `sudo docker ...` works fine even for a user already in the docker group,
 * it's just a password prompt this run didn't strictly need. Since this
 * command runs occasionally (not in a hot loop), that's an acceptable
 * tradeoff for always being correct.
 */
export async function ensureDocker(opts?: { dryRun?: boolean }): Promise<InstallStepResult> {
  const step = 'Docker';

  const versionCheck = await runWithSudoAnnounced('docker', ['--version']);
  const infoCheck = versionCheck.ok ? await runWithSudoAnnounced('docker', ['info']) : { ok: false, stdout: '', stderr: '' };
  if (versionCheck.ok && infoCheck.ok) {
    return { step, status: 'skipped', detail: 'Docker CLI and daemon are already available.' };
  }

  const distro = detectLinuxDistro();
  if (distro.family !== 'debian') {
    return {
      step,
      status: 'unsupported',
      detail: `Automated Docker install is only supported on apt-based distros today (detected: ${distro.prettyName}) — see docs/worker-node-setup.md §4 for manual install instructions.`,
    };
  }

  const installResult = await ensureAptPackages(['docker.io'], opts);
  if (installResult.status !== 'installed') {
    return { step, status: installResult.status, detail: `Failed to install docker.io: ${installResult.detail}` };
  }

  if (opts?.dryRun) {
    return { step, status: 'installed', detail: 'Dry run — would install docker.io, enable the docker service, and add the current user to the docker group.' };
  }

  const enableResult = await runWithSudoAnnounced('systemctl', ['enable', '--now', 'docker'], opts);
  if (!enableResult.ok) {
    return {
      step,
      status: 'failed',
      detail: `Failed to enable/start the docker service: ${enableResult.stderr || enableResult.stdout || '(no output)'}`,
    };
  }

  const username = os.userInfo().username;
  const groupResult = await runWithSudoAnnounced('usermod', ['-aG', 'docker', username], opts);
  if (!groupResult.ok) {
    ui.warn(
      `Could not add ${username} to the docker group (${groupResult.stderr || groupResult.stdout || 'unknown error'}) — ` +
        'docker commands will still work via sudo, but you may want to add the group membership manually.',
    );
  }

  const verify = await runWithSudoAnnounced('docker', ['info'], opts);
  if (!verify.ok) {
    return {
      step,
      status: 'failed',
      detail: `Docker was installed but \`docker info\` still fails: ${verify.stderr || verify.stdout || '(no output)'}`,
    };
  }

  return {
    step,
    status: 'installed',
    detail:
      'Installed docker.io, enabled the docker service, and added the current user to the docker group ' +
      '(a re-login or `newgrp docker` is needed before plain `docker` commands reflect this).',
    requiresRelogin: true,
  };
}

// ---------------------------------------------------------------------------
// compreface-core sidecar container
// ---------------------------------------------------------------------------

/** Must match infra/compose/base.compose.yml and docs/worker-node-setup.md §4.2. */
const COMPREFACE_IMAGE = 'exadel/compreface-core:1.2.0-mobilenet';
const COMPREFACE_CONTAINER_NAME = 'compreface-core';

function containerNamePresent(psOutput: string, name: string): boolean {
  return psOutput
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === name);
}

export async function ensureComprefaceContainer(
  port: number,
  opts?: { dryRun?: boolean },
): Promise<InstallStepResult> {
  const step = 'CompreFace container';

  const running = await runWithSudoAnnounced('docker', [
    'ps',
    '--filter',
    `name=${COMPREFACE_CONTAINER_NAME}`,
    '--format',
    '{{.Names}}',
  ], opts);
  if (running.ok && containerNamePresent(running.stdout, COMPREFACE_CONTAINER_NAME)) {
    return { step, status: 'skipped', detail: `${COMPREFACE_CONTAINER_NAME} container is already running.` };
  }

  const all = await runWithSudoAnnounced('docker', [
    'ps',
    '-a',
    '--filter',
    `name=${COMPREFACE_CONTAINER_NAME}`,
    '--format',
    '{{.Names}}',
  ], opts);
  const exists = all.ok && containerNamePresent(all.stdout, COMPREFACE_CONTAINER_NAME);

  if (exists) {
    if (opts?.dryRun) {
      return { step, status: 'installed', detail: 'Dry run — would start the existing (stopped) compreface-core container.' };
    }
    const start = await runWithSudoAnnounced('docker', ['start', COMPREFACE_CONTAINER_NAME], opts);
    if (!start.ok) {
      return {
        step,
        status: 'failed',
        detail: `Failed to start existing ${COMPREFACE_CONTAINER_NAME} container: ${start.stderr || start.stdout}`,
      };
    }
    return { step, status: 'installed', detail: `Started existing ${COMPREFACE_CONTAINER_NAME} container.` };
  }

  const inspect = await runWithSudoAnnounced('docker', ['image', 'inspect', COMPREFACE_IMAGE], opts);
  if (!inspect.ok) {
    if (opts?.dryRun) {
      return { step, status: 'installed', detail: `Dry run — would pull ${COMPREFACE_IMAGE} and start a new container on port ${port}.` };
    }
    const pull = await runWithSudoAnnounced('docker', ['pull', COMPREFACE_IMAGE], opts);
    if (!pull.ok) {
      return {
        step,
        status: 'failed',
        detail: `Failed to pull ${COMPREFACE_IMAGE}: ${pull.stderr || pull.stdout}`,
      };
    }
  }

  if (opts?.dryRun) {
    return { step, status: 'installed', detail: `Dry run — would start a new ${COMPREFACE_CONTAINER_NAME} container on port ${port}.` };
  }

  const run = await runWithSudoAnnounced(
    'docker',
    [
      'run',
      '-d',
      '--name',
      COMPREFACE_CONTAINER_NAME,
      '-p',
      `${port}:3000`,
      '-e',
      'UWSGI_PROCESSES=1',
      '-e',
      'UWSGI_THREADS=1',
      COMPREFACE_IMAGE,
    ],
    opts,
  );
  if (!run.ok) {
    return {
      step,
      status: 'failed',
      detail: `Failed to start a new ${COMPREFACE_CONTAINER_NAME} container: ${run.stderr || run.stdout}`,
    };
  }

  return { step, status: 'installed', detail: `Started a new ${COMPREFACE_CONTAINER_NAME} container on port ${port}.` };
}

// ---------------------------------------------------------------------------
// compreface-core verification (poll)
// ---------------------------------------------------------------------------

export async function verifyCompreface(
  baseUrl: string,
  opts?: { retries?: number; retryDelayMs?: number },
): Promise<InstallStepResult> {
  const step = 'CompreFace verification';
  const retries = opts?.retries ?? 10;
  const retryDelayMs = opts?.retryDelayMs ?? 2000;

  let lastDetail = 'compreface-core did not respond.';
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await testCompreface(baseUrl);
    if (result.available) {
      return { step, status: 'installed', detail: result.detail ?? `compreface-core verified at ${baseUrl}.` };
    }
    lastDetail = result.detail ?? lastDetail;
    if (attempt < retries) {
      await sleep(retryDelayMs);
    }
  }

  return {
    step,
    status: 'failed',
    detail: `compreface-core did not become healthy after ${retries} attempt(s): ${lastDetail}`,
  };
}

// ---------------------------------------------------------------------------
// Model files (only when already logged in)
// ---------------------------------------------------------------------------

export async function ensureModelsIfConfigured(): Promise<InstallStepResult> {
  const step = 'Model files';
  const cfg = loadConfig();
  if (!cfg?.serverUrl || !cfg.pat) {
    return {
      step,
      status: 'skipped',
      detail: 'Not logged in yet — run `memoriahub login` then re-run to fetch model files.',
    };
  }

  try {
    const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });
    const manifest = await api.getModelManifest();
    if (manifest.length === 0) {
      return { step, status: 'skipped', detail: 'Server manifest lists no model files.' };
    }

    const res = await ensureModels(manifest);
    if (res.failed.length > 0) {
      return {
        step,
        status: 'failed',
        detail: `${res.failed.length} model file(s) failed: ${res.failed
          .map((f) => `${f.name} (${f.error})`)
          .join('; ')}`,
      };
    }

    return {
      step,
      status: res.downloaded.length > 0 ? 'installed' : 'skipped',
      detail: `${res.downloaded.length} downloaded, ${res.present.length} already present in ${res.targetDir}.`,
    };
  } catch (err) {
    return {
      step,
      status: 'failed',
      detail: `Could not fetch/ensure the model manifest: ${errMsg(err)}`,
    };
  }
}
