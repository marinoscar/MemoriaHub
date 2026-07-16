/**
 * node/enroll.ts — One-command worker-node enrollment.
 *
 * `memoriahub node enroll` logs in via the interactive device flow, mints a
 * durable, least-privilege node credential (`nod_` token) via
 * `POST /api/node-credentials`, and stores THAT as the CLI's token — so the
 * node authenticates with a non-expiring, node-scoped credential instead of a
 * soon-to-expire personal access token that had to be hand-copied.
 *
 * The core flow lives in `enrollNode`, which is UI-free and fully
 * dependency-injected (device login, api factory, config persistence) so it is
 * unit-testable without network or filesystem access — mirroring the
 * `registerWorkerNode` precedent in ./register.ts. The command wrapper in
 * commands/node.ts owns all ui.* output and process.exit handling.
 */

import * as os from 'node:os';
import { saveConfig, type CliConfig } from '../config.js';
import { ApiClient, ApiError, type NodeCredentialResult } from '../api.js';
import type { DeviceTokenResult } from '../device-auth.js';

/** Default credential label when the user supplies no `--name`. */
export function defaultNodeCredentialName(hostname: () => string = os.hostname): string {
  return `node-${hostname()}`;
}

/**
 * Thrown when the server does not expose `POST /api/node-credentials` (404) —
 * i.e. an older deployment predating durable node credentials. The command
 * catches this and points the user at the create-a-PAT fallback rather than
 * crashing with a stack trace.
 */
export class NodeEnrollmentUnsupportedError extends Error {
  constructor() {
    super(
      'This server does not support node-credential enrollment yet ' +
        '(POST /api/node-credentials returned 404). Upgrade the server, or run ' +
        '`memoriahub login` and register this machine with that token instead.',
    );
    this.name = 'NodeEnrollmentUnsupportedError';
  }
}

export interface EnrollNodeInput {
  serverUrl: string;
  /** Credential label sent to the server (already resolved/defaulted). */
  name: string;
  /** Existing config (if any) — non-credential fields are preserved. */
  cfg: CliConfig | null;
}

export interface EnrollNodeDeps {
  /** Runs the interactive device flow and returns the session token. */
  deviceLogin: (serverUrl: string) => Promise<DeviceTokenResult>;
  /** Builds an authenticated client from the freshly-issued session token. */
  makeApi: (opts: { serverUrl: string; pat: string }) => Pick<ApiClient, 'createNodeCredential'>;
  /** Persists the resulting config — injectable for tests. */
  saveConfigFn: typeof saveConfig;
}

export interface EnrollNodeResult {
  credential: NodeCredentialResult;
  serverUrl: string;
}

/**
 * Log in, mint a durable node credential, and persist it as the CLI's token.
 *
 * The minted `nod_` token replaces `cfg.pat`; any stored `patExpiresAt` is
 * dropped because a node credential minted here never expires. All other
 * config fields (a prior `nodeId`, `node` settings) are preserved so a machine
 * that was already registered keeps its identity.
 *
 * @throws {NodeEnrollmentUnsupportedError} when the mint endpoint 404s.
 * @throws the underlying error for any other device-login or mint failure.
 */
export async function enrollNode(
  input: EnrollNodeInput,
  deps: EnrollNodeDeps,
): Promise<EnrollNodeResult> {
  const session = await deps.deviceLogin(input.serverUrl);
  const api = deps.makeApi({ serverUrl: input.serverUrl, pat: session.accessToken });

  let credential: NodeCredentialResult;
  try {
    // null = never-expiring node credential (the default for enrollment).
    credential = await api.createNodeCredential(input.name, null);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new NodeEnrollmentUnsupportedError();
    }
    throw err;
  }

  const base: CliConfig = input.cfg ?? { serverUrl: input.serverUrl, pat: '' };
  const nextCfg: CliConfig = { ...base, serverUrl: input.serverUrl, pat: credential.token };
  // A node credential never expires — drop any PAT expiry carried from a prior login.
  delete nextCfg.patExpiresAt;
  deps.saveConfigFn(nextCfg);

  return { credential, serverUrl: input.serverUrl };
}
