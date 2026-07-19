/**
 * test/node/register.spec.ts
 *
 * Unit tests for node/register.ts — the shared registration flow extracted
 * from `node register` so `node start --headless` can self-register in a
 * container, plus the headless-mode resolution helpers.
 *
 * registerWorkerNode is dependency-injected (capability probe, config
 * persistence, hostname), so no network, filesystem, or env mutation leaks
 * out of these tests.
 */

import { jest } from '@jest/globals';
import {
  resolveHeadless,
  resolveStartupSelfTest,
  defaultHeadlessNodeName,
  supportedTypes,
  registerWorkerNode,
  DEFAULT_NODE_POLL_MS,
} from '../../src/node/register.js';
import type { CliConfig } from '../../src/config.js';
import type { ApiClient, NodeRegisterBody, NodeRegisterResult } from '../../src/api.js';
import type { CapabilityStatus } from '../../src/node/capabilities.js';

const BASE_CFG: CliConfig = { serverUrl: 'https://mh.example.com', pat: 'pat-123' };

/** Stub ApiClient recording registerNode calls and returning a fixed result. */
function stubApi(result: NodeRegisterResult): {
  api: ApiClient;
  registerCalls: NodeRegisterBody[];
} {
  const registerCalls: NodeRegisterBody[] = [];
  const api = {
    registerNode: async (body: NodeRegisterBody) => {
      registerCalls.push(body);
      return result;
    },
  } as unknown as ApiClient;
  return { api, registerCalls };
}

describe('resolveHeadless', () => {
  it('is true when the --headless flag is passed', () => {
    expect(resolveHeadless({ headless: true }, {})).toBe(true);
  });

  it('is true when MEMORIAHUB_HEADLESS=1 even without the flag', () => {
    expect(resolveHeadless({}, { MEMORIAHUB_HEADLESS: '1' })).toBe(true);
  });

  it('is false when neither the flag nor the env var is set', () => {
    expect(resolveHeadless({}, {})).toBe(false);
    expect(resolveHeadless({ headless: false }, {})).toBe(false);
  });

  it('does not treat other MEMORIAHUB_HEADLESS values as headless', () => {
    expect(resolveHeadless({}, { MEMORIAHUB_HEADLESS: '0' })).toBe(false);
    expect(resolveHeadless({}, { MEMORIAHUB_HEADLESS: 'true' })).toBe(false);
  });
});

describe('resolveStartupSelfTest', () => {
  // resolveStartupSelfTest falls back to the real process.env when no env
  // argument is supplied, so save/restore around every test to avoid leaking
  // mutations across the suite even though most cases pass an explicit env.
  const ENV_KEY = 'MEMORIAHUB_STARTUP_SELFTEST';
  let prevValue: string | undefined;

  beforeEach(() => {
    prevValue = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (prevValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevValue;
  });

  it('defaults ON in headless mode when the env var is unset', () => {
    expect(resolveStartupSelfTest(true, {})).toBe(true);
  });

  it('defaults OFF in interactive mode when the env var is unset', () => {
    expect(resolveStartupSelfTest(false, {})).toBe(false);
  });

  it('MEMORIAHUB_STARTUP_SELFTEST=0 disables the self-test even in headless mode', () => {
    expect(resolveStartupSelfTest(true, { [ENV_KEY]: '0' })).toBe(false);
  });

  it('MEMORIAHUB_STARTUP_SELFTEST=false disables the self-test even in headless mode', () => {
    expect(resolveStartupSelfTest(true, { [ENV_KEY]: 'false' })).toBe(false);
  });

  it('MEMORIAHUB_STARTUP_SELFTEST=1 forces the self-test on in interactive mode', () => {
    expect(resolveStartupSelfTest(false, { [ENV_KEY]: '1' })).toBe(true);
  });

  it('MEMORIAHUB_STARTUP_SELFTEST=true forces the self-test on in interactive mode', () => {
    expect(resolveStartupSelfTest(false, { [ENV_KEY]: 'true' })).toBe(true);
  });

  it('trims whitespace and is case-insensitive', () => {
    expect(resolveStartupSelfTest(true, { [ENV_KEY]: ' FALSE ' })).toBe(false);
    expect(resolveStartupSelfTest(false, { [ENV_KEY]: ' TRUE ' })).toBe(true);
  });

  it('falls back to the headless default for an unrecognized value', () => {
    expect(resolveStartupSelfTest(true, { [ENV_KEY]: 'yes' })).toBe(true);
    expect(resolveStartupSelfTest(false, { [ENV_KEY]: 'yes' })).toBe(false);
  });

  it('reads from the real process.env by default (no env argument supplied)', () => {
    process.env[ENV_KEY] = '0';
    expect(resolveStartupSelfTest(true)).toBe(false);

    process.env[ENV_KEY] = '1';
    expect(resolveStartupSelfTest(false)).toBe(true);
  });
});

describe('defaultHeadlessNodeName', () => {
  const hostname = (): string => 'box42';

  it('prefers the config-stored node name (env-overlaid by Phase 1)', () => {
    const cfg: CliConfig = { ...BASE_CFG, node: { name: 'my-node' } };
    expect(defaultHeadlessNodeName(cfg, { MEMORIAHUB_NODE_NAME: 'env-node' }, hostname)).toBe(
      'my-node',
    );
  });

  it('falls back to MEMORIAHUB_NODE_NAME when config carries no name', () => {
    expect(defaultHeadlessNodeName(BASE_CFG, { MEMORIAHUB_NODE_NAME: ' env-node ' }, hostname)).toBe(
      'env-node',
    );
  });

  it('falls back to worker-<hostname> when neither config nor env name a node', () => {
    expect(defaultHeadlessNodeName(BASE_CFG, {}, hostname)).toBe('worker-box42');
    expect(defaultHeadlessNodeName(BASE_CFG, { MEMORIAHUB_NODE_NAME: '   ' }, hostname)).toBe(
      'worker-box42',
    );
  });
});

describe('registerWorkerNode', () => {
  const caps: Record<string, CapabilityStatus> = {
    // Only geocode's (empty) requirements are satisfiable with everything
    // unavailable — makes auto-detected eligible types deterministic.
    sharp: { available: false },
    human: { available: false },
    ffmpeg: { available: false },
    ffprobe: { available: false },
    compreface: { available: false },
  };
  const detectFn = async (): Promise<Record<string, CapabilityStatus>> => caps;

  it('registers with the supplied name and persists nodeId + node config', async () => {
    const { api, registerCalls } = stubApi({ nodeId: 'node-abc' });
    const saveConfigFn = jest.fn();

    const res = await registerWorkerNode(
      {
        cfg: BASE_CFG,
        api,
        name: 'worker-box42',
        concurrency: 3,
        requestedTypes: ['geocode', 'auto_tagging'],
        faceProvider: 'human',
        cliVersion: '1.2.3',
      },
      { detectFn, saveConfigFn, hostnameFn: () => 'box42' },
    );

    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]).toMatchObject({
      name: 'worker-box42',
      hostname: 'box42',
      cliVersion: '1.2.3',
      eligibleTypes: ['geocode', 'auto_tagging'],
      concurrency: 3,
    });

    expect(res.nodeId).toBe('node-abc');
    expect(res.reattached).toBe(false);
    expect(res.eligibleTypes).toEqual(['geocode', 'auto_tagging']);

    expect(saveConfigFn).toHaveBeenCalledTimes(1);
    expect(saveConfigFn).toHaveBeenCalledWith({
      ...BASE_CFG,
      nodeId: 'node-abc',
      node: {
        name: 'worker-box42',
        concurrency: 3,
        eligibleTypes: ['geocode', 'auto_tagging'],
        pollIntervalMs: DEFAULT_NODE_POLL_MS,
        faceProvider: 'human',
        comprefaceUrl: undefined,
      },
    });
  });

  it('surfaces reattached:true when the server re-attached to an existing node row', async () => {
    const { api } = stubApi({ nodeId: 'node-abc', reattached: true });
    const saveConfigFn = jest.fn();

    const res = await registerWorkerNode(
      {
        cfg: BASE_CFG,
        api,
        name: 'worker-box42',
        concurrency: 1,
        requestedTypes: ['geocode'],
        faceProvider: 'human',
        cliVersion: '1.2.3',
      },
      { detectFn, saveConfigFn, hostnameFn: () => 'box42' },
    );

    expect(res.reattached).toBe(true);
    // The (possibly pre-existing) nodeId is still persisted for re-attach runs.
    expect(saveConfigFn).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'node-abc' }));
  });

  it('auto-detects eligible types from capabilities when requestedTypes is empty', async () => {
    const { api, registerCalls } = stubApi({ nodeId: 'node-abc' });
    const saveConfigFn = jest.fn();

    const res = await registerWorkerNode(
      {
        cfg: BASE_CFG,
        api,
        name: 'n',
        concurrency: 1,
        requestedTypes: [],
        faceProvider: 'human',
        cliVersion: '1.2.3',
      },
      { detectFn, saveConfigFn, hostnameFn: () => 'box42' },
    );

    // With no capabilities available, only the two job types with no
    // requirements survive: geocode and workflow_execute_batch (pure-JS
    // declaration pass, no native libs — see NODE_JOB_TYPES ordering).
    expect(registerCalls[0]?.eligibleTypes).toEqual(['geocode', 'workflow_execute_batch']);
    expect(res.eligibleTypes).toEqual(['geocode', 'workflow_execute_batch']);
  });

  it('preserves an existing configured poll interval', async () => {
    const { api } = stubApi({ nodeId: 'node-abc' });
    const saveConfigFn = jest.fn();
    const cfg: CliConfig = { ...BASE_CFG, node: { pollIntervalMs: 9999 } };

    const res = await registerWorkerNode(
      {
        cfg,
        api,
        name: 'n',
        concurrency: 1,
        requestedTypes: ['geocode'],
        faceProvider: 'human',
        cliVersion: '1.2.3',
      },
      { detectFn, saveConfigFn, hostnameFn: () => 'box42' },
    );

    expect(res.node.pollIntervalMs).toBe(9999);
  });

  it('propagates registerNode API errors to the caller (no exit handling inside)', async () => {
    const api = {
      registerNode: async () => {
        throw new Error('403 forbidden');
      },
    } as unknown as ApiClient;
    const saveConfigFn = jest.fn();

    await expect(
      registerWorkerNode(
        {
          cfg: BASE_CFG,
          api,
          name: 'n',
          concurrency: 1,
          requestedTypes: ['geocode'],
          faceProvider: 'human',
          cliVersion: '1.2.3',
        },
        { detectFn, saveConfigFn, hostnameFn: () => 'box42' },
      ),
    ).rejects.toThrow('403 forbidden');
    expect(saveConfigFn).not.toHaveBeenCalled();
  });
});

describe('supportedTypes', () => {
  it('returns only the job types whose requirements are fully satisfied', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      human: { available: false },
      ffmpeg: { available: true },
      ffprobe: { available: false },
    };
    const types = supportedTypes(caps, 'human');
    expect(types).toContain('thumbnail_regen'); // sharp + ffmpeg
    expect(types).toContain('geocode'); // no requirements
    expect(types).not.toContain('face_detection'); // human missing
    expect(types).not.toContain('social_media_detection'); // ffprobe missing
  });
});
