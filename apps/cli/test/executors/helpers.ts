import type { ExecutorNodeApi, JobExecutionContext } from '@marinoscar/platform-cli/node';

export interface FakeApi extends ExecutorNodeApi {
  secretCalls: unknown[][];
  uploadCalls: unknown[][];
}

/** A hand-built engine context: what the platform engine would hand an executor. */
export function makeContext(
  over: Partial<JobExecutionContext> & { type: string; api?: Partial<ExecutorNodeApi> },
): { context: JobExecutionContext; api: FakeApi; logs: string[] } {
  const logs: string[] = [];
  const api: FakeApi = {
    secretCalls: [],
    uploadCalls: [],
    jobSecret: async (...args: unknown[]) => {
      api.secretCalls.push(args);
      return { kind: 'geo.google', expiresAt: new Date(Date.now() + 60_000).toISOString(), material: { apiKey: 'AIza-test-key-0001' } };
    },
    uploadUrl: async (...args: unknown[]) => {
      api.uploadCalls.push(args);
      return { url: 'https://store.example.test/put?sig=abc', key: 'node-outputs/job-1/obj-1', expiresIn: 60, expiresAt: new Date().toISOString() };
    },
    downloadUrl: async () => ({ url: 'https://store.example.test/get', expiresIn: 60, expiresAt: new Date().toISOString() }) as never,
    ...(over.api as object),
  } as FakeApi;
  const context = {
    job: { id: 'job-1', type: over.type, subjectType: 'media_item', subjectId: 'item-1', priority: 0, attempts: 1, startedAt: null, leaseExpiresAt: null },
    params: {},
    inputPath: undefined,
    input: undefined,
    api,
    nodeId: 'node-1',
    claimToken: 'claim-1',
    signal: new AbortController().signal,
    log: (message: string) => void logs.push(message),
    ...over,
  } as unknown as JobExecutionContext;
  (context as { api: FakeApi }).api = api;
  return { context, api, logs };
}
