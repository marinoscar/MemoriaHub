/**
 * node/doctor-checks.ts — API-access and daemon-liveness checks for
 * `memoriahub node doctor`.
 *
 * Complements node/self-test.ts (local compute capability health) with two
 * more health dimensions a worker node needs to actually do useful work:
 *
 *   1. API access — is the configured PAT still valid, does the node's
 *      server-side registration still exist, is the model manifest reachable.
 *   2. Daemon liveness — is a `node start` process currently running on this
 *      machine (and, if so, a quick live snapshot), or is there a stale
 *      pidfile left behind by a crashed daemon.
 *
 * Both reuse the exact same ApiClient/IPC call patterns already used inline
 * by `node status` / `node list` / `node stop` in commands/node.ts — no new
 * endpoints, no new IPC commands.
 */

import { ApiError, type ApiClient } from '../api.js';
import { readPidFile, isPidAlive, type DaemonPidInfo } from './daemon.js';
import { connectToDaemon, isDaemonRunning } from './ipc-client.js';
import { nodePidPath } from '../paths.js';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// API access
// ---------------------------------------------------------------------------

export interface ApiAccessCheckResult {
  authOk: boolean;
  authDetail: string;
  /** null = not applicable (node not registered locally, so nothing to check). */
  nodeRegistrationOk: boolean | null;
  nodeRegistrationDetail: string;
  manifestOk: boolean;
  manifestDetail: string;
}

/**
 * Run the API-access checks:
 *
 *   - Auth roundtrip: `GET /api/auth/me` — the same call `node doctor` already
 *     made inline for its old "Connectivity" section. A 2xx here also implies
 *     the claim/renew/result/failure endpoints will authenticate, since they
 *     share the same PAT/JWT permission set (jobs:write) — there is no
 *     side-effect-free way to probe claim permission specifically without
 *     actually claiming (and thus consuming) a job, so that sub-check is
 *     folded into this one rather than given its own probe.
 *   - Node registration validity: best-effort `GET /api/nodes/:id`, mirroring
 *     the inline call already used by `node status` (same 403/404 tolerance —
 *     an older server without a per-node GET, or a token without permission,
 *     degrades to "could not verify" rather than a hard failure).
 *   - Model manifest reachability: `getModelManifest()` (already used by
 *     `node start`/`node doctor`'s existing Models section) — confirms it
 *     resolves without throwing and lists at least one file.
 */
export async function runApiAccessChecks(
  api: ApiClient,
  nodeId: string | undefined,
): Promise<ApiAccessCheckResult> {
  const result: ApiAccessCheckResult = {
    authOk: false,
    authDetail: '',
    nodeRegistrationOk: null,
    nodeRegistrationDetail: 'not registered locally (no nodeId in config) — skipped',
    manifestOk: false,
    manifestDetail: '',
  };

  try {
    await api.get<unknown>('/api/auth/me');
    result.authOk = true;
    result.authDetail = 'token valid — claim/renew/result/failure permission (jobs:write) implied';
  } catch (err) {
    result.authOk = false;
    result.authDetail = errMsg(err);
  }

  if (nodeId) {
    try {
      await api.get<unknown>(`/api/nodes/${encodeURIComponent(nodeId)}`);
      result.nodeRegistrationOk = true;
      result.nodeRegistrationDetail = 'node record found server-side';
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        result.nodeRegistrationOk = false;
        result.nodeRegistrationDetail = `node record not found or inaccessible (HTTP ${err.status}) — may need \`node register\` again`;
      } else {
        result.nodeRegistrationOk = null;
        result.nodeRegistrationDetail = `could not verify (${errMsg(err)}) — endpoint may not support per-node GET with this token`;
      }
    }
  }

  try {
    const manifest = await api.getModelManifest();
    result.manifestOk = Array.isArray(manifest) && manifest.length > 0;
    result.manifestDetail = result.manifestOk
      ? `reachable — ${manifest.length} model file(s) listed`
      : 'reachable, but the manifest lists no model files';
  } catch (err) {
    result.manifestOk = false;
    result.manifestDetail = errMsg(err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Daemon liveness
// ---------------------------------------------------------------------------

export interface DaemonLivenessResult {
  /** True when the IPC socket is live and answered a status query. */
  running: boolean;
  /** True when a pidfile exists but refers to a dead process (crash left it behind). */
  stalePidfile: boolean;
  pidInfo: DaemonPidInfo | null;
  /** A quick snapshot (uptime/concurrency/etc.) when `running` — best-effort. */
  snapshot: Record<string, unknown> | null;
  detail: string;
}

/**
 * Check whether a worker-node daemon (`node start`, foreground or --daemon)
 * is currently running on this machine, using the same authoritative
 * live-socket check (`isDaemonRunning`) the `node stop`/`node status`
 * commands already use, plus the pidfile-based stale-instance detection
 * `daemon.ts` itself performs at startup (`readPidFile` + `isPidAlive`).
 */
export async function checkDaemonLiveness(): Promise<DaemonLivenessResult> {
  const live = await isDaemonRunning();
  if (live) {
    try {
      const client = await connectToDaemon();
      client.send({ cmd: 'status' });
      const msg = await client.waitFor((m) => m.kind === 'status', 3000);
      client.close();
      return {
        running: true,
        stalePidfile: false,
        pidInfo: readPidFile(nodePidPath()),
        snapshot: msg as unknown as Record<string, unknown>,
        detail: 'daemon responding over IPC',
      };
    } catch (err) {
      return {
        running: true,
        stalePidfile: false,
        pidInfo: readPidFile(nodePidPath()),
        snapshot: null,
        detail: `IPC socket is live but did not answer a status query in time: ${errMsg(err)}`,
      };
    }
  }

  const pidInfo = readPidFile(nodePidPath());
  if (pidInfo) {
    if (isPidAlive(pidInfo.pid)) {
      return {
        running: false,
        stalePidfile: false,
        pidInfo,
        snapshot: null,
        detail: `pidfile present (pid ${pidInfo.pid}, process alive) but the IPC socket is not responding — daemon may be starting up or wedged`,
      };
    }
    return {
      running: false,
      stalePidfile: true,
      pidInfo,
      snapshot: null,
      detail: `stale pidfile found (pid ${pidInfo.pid} is not running) — a previous daemon likely crashed without cleaning up; a fresh \`node start\` will remove it automatically`,
    };
  }

  return {
    running: false,
    stalePidfile: false,
    pidInfo: null,
    snapshot: null,
    detail: 'no worker-node daemon running on this machine',
  };
}
