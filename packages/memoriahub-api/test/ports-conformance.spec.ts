import { z } from 'zod';

import {
  FakeMemoriahubAccess,
  FakeMemoriahubAi,
  FakeMemoriahubIdentity,
  FakeMemoriahubJobs,
  FakeMemoriahubNotify,
  FakeMemoriahubSecrets,
  FakeMemoriahubSettings,
  InMemoryMemoriahubObjectStorePort,
  RecordingMemoriahubAudit,
  RecordingMemoriahubMetrics,
  RecordingMemoriahubWebhooks,
  describeMemoriahubPortsConformance,
  type MemoriahubPortsUnderTest,
} from '../src/testing/index.js';
import { InProcessMemoriahubEvents } from '../src/core/index.js';

function fakesUnderTest(): MemoriahubPortsUnderTest {
  const jobs = new FakeMemoriahubJobs();
  const ai = new FakeMemoriahubAi();
  const access = new FakeMemoriahubAccess();
  access.addGroup('scope-1', 'Library Alpha', { 'user-viewer': 'viewer', 'user-editor': 'editor', 'user-admin': 'admin' });
  access.grant('user-grantee', 'media_item', 'item-granted', ['read']);
  const identity = new FakeMemoriahubIdentity();
  identity.addUser({ userId: 'user-1', orgId: null, roles: ['contributor'], permissions: new Set(['media:read']) });
  const settings = new FakeMemoriahubSettings();
  const namespace = { scope: 'system' as const, name: 'dedup', schema: z.object({ hashMaxDistance: z.number() }), defaults: { hashMaxDistance: 6 } };
  const userNamespace = { scope: 'user' as const, name: 'memories', schema: z.object({ emailDigestOptOut: z.boolean() }), defaults: { emailDigestOptOut: false } };
  settings.registerNamespace(namespace);
  settings.registerNamespace(userNamespace);

  return {
    jobs: { port: jobs, drain: () => jobs.drain() },
    ai: {
      port: ai,
      failNextWith: (errorClass) => {
        ai.failNext(errorClass);
        return true;
      },
    },
    objectStore: { port: new InMemoryMemoriahubObjectStorePort() },
    access: {
      port: access,
      scope: {
        scopeId: 'scope-1',
        viewerId: 'user-viewer',
        editorId: 'user-editor',
        adminId: 'user-admin',
        outsiderId: 'user-outsider',
        unknownScopeId: 'scope-missing',
        bypassPermission: 'groups:admin',
      },
      grants: {
        granteeId: 'user-grantee',
        mediaItemId: 'item-granted',
        otherMediaItemId: 'item-other',
        scopeItemId: 'item-in-scope',
        // The fakes' records: the fake evaluates the `{ id: { in } }` fragment its `sharedWhere` answers.
        matching: async ({ scopeIds, shared }) => {
          const records = [
            { id: 'item-granted', scopeId: 'scope-granted-elsewhere' },
            { id: 'item-other', scopeId: 'scope-other' },
            { id: 'item-in-scope', scopeId: 'scope-1' },
          ];
          const sharedIds = new Set(((shared as { id?: { in?: string[] } } | null)?.id?.in) ?? []);
          return records.filter((r) => scopeIds.includes(r.scopeId) || sharedIds.has(r.id)).map((r) => r.id);
        },
      },
    },
    identity: {
      port: identity,
      anonymous: identity.contextFor(null),
      authenticated: identity.contextFor('user-1'),
      permissions: { granted: 'media:read', notGranted: 'media:write' },
    },
    notify: { port: new FakeMemoriahubNotify(), event: { key: 'upload_completed', userId: 'user-1' } },
    events: { port: new InProcessMemoriahubEvents() },
    settings: {
      port: settings,
      namespaces: [namespace, userNamespace],
      system: { name: 'dedup', patch: { hashMaxDistance: 8 }, actorUserId: 'user-1' },
      user: { name: 'memories', userId: 'user-1', patch: { emailDigestOptOut: true } },
    },
    secrets: { port: new FakeMemoriahubSecrets(), purpose: 'geo_provider', name: 'google', actorUserId: 'user-1' },
    audit: { port: new RecordingMemoriahubAudit() },
    webhooks: { port: new RecordingMemoriahubWebhooks() },
    metrics: { port: new RecordingMemoriahubMetrics() },
  };
}

describeMemoriahubPortsConformance('the in-memory fakes', fakesUnderTest, { describe, it, expect }, { sharedWhereSql: true });
