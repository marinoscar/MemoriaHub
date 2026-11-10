import { InProcessMemoriahubEvents } from '../core/index.js';
import type { MemoriahubPortBindings } from '../core/index.js';
import { FakeMemoriahubAccess } from './fake-access.js';
import { FakeMemoriahubAi } from './fake-ai.js';
import { FakeMemoriahubIdentity } from './fake-identity.js';
import { FakeMemoriahubJobs } from './fake-jobs.js';
import { FakeMemoriahubNotify } from './fake-notify.js';
import { FakeMemoriahubPrisma } from './fake-prisma.js';
import { FakeMemoriahubSecrets } from './fake-secrets.js';
import { FakeMemoriahubSettings } from './fake-settings.js';
import { InMemoryMemoriahubObjectStorePort } from './in-memory-object-store.js';
import {
  RecordingMemoriahubAudit,
  RecordingMemoriahubMetrics,
  RecordingMemoriahubWebhooks,
} from './recording-ports.js';

/**
 * A full set of in-memory ports: what a slice's unit test is built on, with no platform and no database.
 *
 * @stability experimental
 */
export interface FakeMemoriahubPorts {
  /** The database port. */
  prisma: FakeMemoriahubPrisma;
  /** The job port. */
  jobs: FakeMemoriahubJobs;
  /** The model port. */
  ai: FakeMemoriahubAi;
  /** The object-store port. */
  objectStore: InMemoryMemoriahubObjectStorePort;
  /** The access port. */
  access: FakeMemoriahubAccess;
  /** The identity port. */
  identity: FakeMemoriahubIdentity;
  /** The notification port. */
  notify: FakeMemoriahubNotify;
  /** The settings port. */
  settings: FakeMemoriahubSettings;
  /** The secrets port. */
  secrets: FakeMemoriahubSecrets;
  /** The event port. */
  events: InProcessMemoriahubEvents;
  /** The audit port. */
  audit: RecordingMemoriahubAudit;
  /** The webhook port. */
  webhooks: RecordingMemoriahubWebhooks;
  /** The metrics port. */
  metrics: RecordingMemoriahubMetrics;
}

/**
 * Builds a fresh set of in-memory ports.
 *
 * @returns the ports.
 * @stability experimental
 */
export function createFakeMemoriahubPorts(): FakeMemoriahubPorts {
  return {
    prisma: new FakeMemoriahubPrisma(),
    jobs: new FakeMemoriahubJobs(),
    ai: new FakeMemoriahubAi(),
    objectStore: new InMemoryMemoriahubObjectStorePort(),
    access: new FakeMemoriahubAccess(),
    identity: new FakeMemoriahubIdentity(),
    notify: new FakeMemoriahubNotify(),
    settings: new FakeMemoriahubSettings(),
    secrets: new FakeMemoriahubSecrets(),
    events: new InProcessMemoriahubEvents(),
    audit: new RecordingMemoriahubAudit(),
    webhooks: new RecordingMemoriahubWebhooks(),
    metrics: new RecordingMemoriahubMetrics(),
  };
}

/**
 * The `MemoriahubPortsModule.forRoot` bindings of a set of fakes, so a Nest testing module gets every
 * port by its token.
 *
 * @param ports - the fakes.
 * @returns the bindings.
 * @stability experimental
 */
export function fakeMemoriahubBindings(ports: FakeMemoriahubPorts = createFakeMemoriahubPorts()): MemoriahubPortBindings {
  return {
    prisma: { useValue: ports.prisma },
    jobs: { useValue: ports.jobs },
    ai: { useValue: ports.ai },
    objectStore: { useValue: ports.objectStore },
    access: { useValue: ports.access },
    identity: { useValue: ports.identity },
    notify: { useValue: ports.notify },
    settings: { useValue: ports.settings },
    secrets: { useValue: ports.secrets },
    events: { useValue: ports.events },
    audit: { useValue: ports.audit },
    webhooks: { useValue: ports.webhooks },
    metrics: { useValue: ports.metrics },
  };
}
