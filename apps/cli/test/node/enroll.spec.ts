/**
 * test/node/enroll.spec.ts
 *
 * Unit tests for node/enroll.ts — the pure, dependency-injected core of
 * `memoriahub node enroll`. Device login, the api factory, and config
 * persistence are all injected, so these tests touch no network, filesystem,
 * or interactive prompt.
 *
 * Coverage:
 *   1. Happy path — device login → mint (name, null) → nod_ token stored as pat.
 *   2. Older-server 404 → NodeEnrollmentUnsupportedError, config NOT written.
 *   3. Credential-name defaulting (defaultNodeCredentialName).
 */

import { jest } from '@jest/globals';
import {
  enrollNode,
  defaultNodeCredentialName,
  NodeEnrollmentUnsupportedError,
} from '../../src/node/enroll.js';
import { ApiError, type ApiClient, type NodeCredentialResult } from '../../src/api.js';
import type { CliConfig } from '../../src/config.js';
import type { DeviceTokenResult } from '../../src/device-auth.js';

const BASE_CFG: CliConfig = { serverUrl: 'https://mh.example.com', pat: 'pat-old' };

const CREDENTIAL: NodeCredentialResult = {
  id: 'cred-1',
  name: 'node-box42',
  token: 'nod_secret_full_token_value',
  tokenPrefix: 'nod_secret',
  createdAt: '2026-07-16T00:00:00.000Z',
  expiresAt: null,
};

/** Build injectable deps with a recording createNodeCredential + saveConfig. */
function makeDeps(opts: {
  session?: DeviceTokenResult;
  mint?: (name: string, expiresAt?: string | null) => Promise<NodeCredentialResult>;
}): {
  deps: Parameters<typeof enrollNode>[1];
  mintCalls: Array<[string, string | null | undefined]>;
  saveConfigFn: jest.Mock;
  loginCalls: string[];
} {
  const mintCalls: Array<[string, string | null | undefined]> = [];
  const loginCalls: string[] = [];
  const saveConfigFn = jest.fn();

  const mint =
    opts.mint ??
    (async (): Promise<NodeCredentialResult> => CREDENTIAL);

  const deps: Parameters<typeof enrollNode>[1] = {
    deviceLogin: async (serverUrl: string): Promise<DeviceTokenResult> => {
      loginCalls.push(serverUrl);
      return opts.session ?? { accessToken: 'session-pat-xyz', expiresAt: '2026-10-14T00:00:00.000Z' };
    },
    makeApi: (): Pick<ApiClient, 'createNodeCredential'> => ({
      createNodeCredential: (name: string, expiresAt?: string | null) => {
        mintCalls.push([name, expiresAt]);
        return mint(name, expiresAt);
      },
    }),
    saveConfigFn: saveConfigFn as unknown as typeof import('../../src/config.js').saveConfig,
  };

  return { deps, mintCalls, saveConfigFn, loginCalls };
}

describe('defaultNodeCredentialName', () => {
  it('is node-<hostname>', () => {
    expect(defaultNodeCredentialName(() => 'box42')).toBe('node-box42');
  });

  it('uses os.hostname by default (non-empty)', () => {
    expect(defaultNodeCredentialName()).toMatch(/^node-.+/);
  });
});

describe('enrollNode', () => {
  it('logs in, mints a never-expiring credential, and stores it as the CLI token', async () => {
    const { deps, mintCalls, saveConfigFn, loginCalls } = makeDeps({});

    const res = await enrollNode(
      { serverUrl: 'https://mh.example.com', name: 'node-box42', cfg: BASE_CFG },
      deps,
    );

    // Device login ran against the given server.
    expect(loginCalls).toEqual(['https://mh.example.com']);

    // Mint was called with the resolved name and an explicit null expiry.
    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0]).toEqual(['node-box42', null]);

    // The nod_ token replaced cfg.pat; server URL preserved.
    expect(saveConfigFn).toHaveBeenCalledTimes(1);
    expect(saveConfigFn).toHaveBeenCalledWith({
      serverUrl: 'https://mh.example.com',
      pat: 'nod_secret_full_token_value',
    });

    expect(res.credential).toBe(CREDENTIAL);
    expect(res.serverUrl).toBe('https://mh.example.com');
  });

  it('preserves nodeId/node settings and drops a stale patExpiresAt', async () => {
    const cfg: CliConfig = {
      ...BASE_CFG,
      patExpiresAt: '2026-08-01T00:00:00.000Z',
      nodeId: 'node-abc',
      node: { name: 'box42', concurrency: 2 },
    };
    const { deps, saveConfigFn } = makeDeps({});

    await enrollNode({ serverUrl: 'https://mh.example.com', name: 'node-box42', cfg }, deps);

    const saved = saveConfigFn.mock.calls[0][0] as CliConfig;
    expect(saved.pat).toBe('nod_secret_full_token_value');
    expect(saved.nodeId).toBe('node-abc');
    expect(saved.node).toEqual({ name: 'box42', concurrency: 2 });
    expect(saved.patExpiresAt).toBeUndefined();
  });

  it('works with no prior config (fresh enrollment)', async () => {
    const { deps, saveConfigFn } = makeDeps({});

    await enrollNode({ serverUrl: 'https://fresh.example.com', name: 'node-x', cfg: null }, deps);

    expect(saveConfigFn).toHaveBeenCalledWith({
      serverUrl: 'https://fresh.example.com',
      pat: 'nod_secret_full_token_value',
    });
  });

  it('throws NodeEnrollmentUnsupportedError on a 404 and does NOT persist config', async () => {
    const { deps, saveConfigFn } = makeDeps({
      mint: async () => {
        throw new ApiError(404, 'Not Found');
      },
    });

    await expect(
      enrollNode({ serverUrl: 'https://old.example.com', name: 'node-x', cfg: BASE_CFG }, deps),
    ).rejects.toBeInstanceOf(NodeEnrollmentUnsupportedError);

    expect(saveConfigFn).not.toHaveBeenCalled();
  });

  it('propagates other API errors unchanged (no config written)', async () => {
    const { deps, saveConfigFn } = makeDeps({
      mint: async () => {
        throw new ApiError(403, 'Forbidden');
      },
    });

    await expect(
      enrollNode({ serverUrl: 'https://mh.example.com', name: 'node-x', cfg: BASE_CFG }, deps),
    ).rejects.toMatchObject({ status: 403 });

    expect(saveConfigFn).not.toHaveBeenCalled();
  });

  it('propagates a device-login failure without minting or persisting', async () => {
    const saveConfigFn = jest.fn();
    const mintFn = jest.fn();
    const deps: Parameters<typeof enrollNode>[1] = {
      deviceLogin: async () => {
        throw new Error('authorization timed out');
      },
      makeApi: () => ({
        createNodeCredential: mintFn as unknown as ApiClient['createNodeCredential'],
      }),
      saveConfigFn: saveConfigFn as unknown as typeof import('../../src/config.js').saveConfig,
    };

    await expect(
      enrollNode({ serverUrl: 'https://mh.example.com', name: 'node-x', cfg: BASE_CFG }, deps),
    ).rejects.toThrow('authorization timed out');

    expect(mintFn).not.toHaveBeenCalled();
    expect(saveConfigFn).not.toHaveBeenCalled();
  });
});
