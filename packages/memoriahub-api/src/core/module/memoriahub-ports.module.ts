import {
  type DynamicModule,
  Global,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type OptionalFactoryDependency,
  type Provider,
  type Type,
} from '@nestjs/common';

import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_AI,
  MEMORIAHUB_AUDIT,
  MEMORIAHUB_EVENTS,
  MEMORIAHUB_IDENTITY,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_METRICS,
  MEMORIAHUB_NOTIFY,
  MEMORIAHUB_OBJECT_STORE,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SECRETS,
  MEMORIAHUB_SETTINGS,
  MEMORIAHUB_WEBHOOKS,
  type MemoriahubAccessPort,
  type MemoriahubAiPort,
  type MemoriahubAuditPort,
  type MemoriahubEventsPort,
  type MemoriahubIdentityPort,
  type MemoriahubJobsPort,
  type MemoriahubMetricsPort,
  type MemoriahubNotifyPort,
  type MemoriahubObjectStorePort,
  type MemoriahubPrismaClientLike,
  type MemoriahubSecretsPort,
  type MemoriahubSettingsPort,
  type MemoriahubWebhooksPort,
} from '../../ports/index.js';
import { InProcessMemoriahubEvents } from '../events/in-process-events.js';

/**
 * Binds a port to a class Nest instantiates.
 *
 * @stability experimental
 */
export interface MemoriahubClassBinding<T> {
  /** The class; it must be `@Injectable` and its dependencies resolvable. */
  useClass: Type<T>;
}

/**
 * Binds a port to a provider that already exists.
 *
 * @stability experimental
 */
export interface MemoriahubExistingBinding<T> {
  /** The existing provider's class or token. */
  useExisting: Type<T> | string | symbol;
}

/**
 * Binds a port to a ready value.
 *
 * @stability experimental
 */
export interface MemoriahubValueBinding<T> {
  /** The instance. */
  useValue: T;
}

/**
 * Binds a port to a factory.
 *
 * @stability experimental
 */
export interface MemoriahubFactoryBinding<T> {
  /** Builds the port from its dependencies. */
  useFactory: (...deps: any[]) => T | Promise<T>;
  /** The dependencies passed to `useFactory`. */
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

/**
 * How a host binds one port: a class, an existing provider, a ready value or a factory. The same four
 * shapes as a Nest custom provider, minus the token.
 *
 * @stability experimental
 */
export type MemoriahubPortBinding<T> =
  | MemoriahubClassBinding<T>
  | MemoriahubExistingBinding<T>
  | MemoriahubValueBinding<T>
  | MemoriahubFactoryBinding<T>;

/**
 * The bindings of every port. The first nine are required; `events`, `audit`, `webhooks` and `metrics`
 * are optional and default to an in-process emitter and three no-ops.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubPortBindings {
  /** The database port, bound to `MEMORIAHUB_PRISMA`. */
  prisma: MemoriahubPortBinding<MemoriahubPrismaClientLike>;
  /** The job port, bound to `MEMORIAHUB_JOBS`. */
  jobs: MemoriahubPortBinding<MemoriahubJobsPort>;
  /** The model port, bound to `MEMORIAHUB_AI`. */
  ai: MemoriahubPortBinding<MemoriahubAiPort>;
  /** The object-store port, bound to `MEMORIAHUB_OBJECT_STORE`. */
  objectStore: MemoriahubPortBinding<MemoriahubObjectStorePort>;
  /** The access port, bound to `MEMORIAHUB_ACCESS`. */
  access: MemoriahubPortBinding<MemoriahubAccessPort>;
  /** The identity port, bound to `MEMORIAHUB_IDENTITY`. */
  identity: MemoriahubPortBinding<MemoriahubIdentityPort>;
  /** The notification port, bound to `MEMORIAHUB_NOTIFY`. */
  notify: MemoriahubPortBinding<MemoriahubNotifyPort>;
  /** The settings port, bound to `MEMORIAHUB_SETTINGS`. */
  settings: MemoriahubPortBinding<MemoriahubSettingsPort>;
  /** The secrets port, bound to `MEMORIAHUB_SECRETS`. */
  secrets: MemoriahubPortBinding<MemoriahubSecretsPort>;
  /** The event port, bound to `MEMORIAHUB_EVENTS`. Optional; defaults to an in-process emitter. */
  events?: MemoriahubPortBinding<MemoriahubEventsPort>;
  /** The audit port, bound to `MEMORIAHUB_AUDIT`. Optional; defaults to a no-op. */
  audit?: MemoriahubPortBinding<MemoriahubAuditPort>;
  /** The webhook port, bound to `MEMORIAHUB_WEBHOOKS`. Optional; defaults to a no-op. */
  webhooks?: MemoriahubPortBinding<MemoriahubWebhooksPort>;
  /** The metrics port, bound to `MEMORIAHUB_METRICS`. Optional; defaults to a no-op. */
  metrics?: MemoriahubPortBinding<MemoriahubMetricsPort>;
  /** Modules the bindings' providers need (a binding by `useClass` resolves its dependencies from them). */
  imports?: ModuleMetadata['imports'];
}

/**
 * The options of {@link MemoriahubPortsModule.forRoot}.
 *
 * @stability experimental
 */
export interface MemoriahubPortsOptions {
  /** The port bindings. */
  ports: MemoriahubPortBindings;
}

/**
 * An audit port that records nothing: the default when a host binds none.
 *
 * @stability experimental
 */
export const NOOP_MEMORIAHUB_AUDIT: MemoriahubAuditPort = Object.freeze({
  async record(): Promise<void> {
    // Intentionally empty.
  },
});

/**
 * A webhook port that publishes nothing: the default when a host binds none.
 *
 * @stability experimental
 */
export const NOOP_MEMORIAHUB_WEBHOOKS: MemoriahubWebhooksPort = Object.freeze({
  async emit(): Promise<void> {
    // Intentionally empty.
  },
});

/**
 * A metrics port that records nothing: the default when a host binds none.
 *
 * @stability experimental
 */
export const NOOP_MEMORIAHUB_METRICS: MemoriahubMetricsPort = Object.freeze({
  add(): void {
    // Intentionally empty.
  },
  record(): void {
    // Intentionally empty.
  },
});

type RequiredPort = Exclude<keyof MemoriahubPortBindings, 'events' | 'audit' | 'webhooks' | 'metrics' | 'imports'>;

/** Required ports in the order they are reported, with their tokens. */
const REQUIRED: ReadonlyArray<readonly [RequiredPort, symbol, string]> = [
  ['prisma', MEMORIAHUB_PRISMA, 'MEMORIAHUB_PRISMA'],
  ['jobs', MEMORIAHUB_JOBS, 'MEMORIAHUB_JOBS'],
  ['ai', MEMORIAHUB_AI, 'MEMORIAHUB_AI'],
  ['objectStore', MEMORIAHUB_OBJECT_STORE, 'MEMORIAHUB_OBJECT_STORE'],
  ['access', MEMORIAHUB_ACCESS, 'MEMORIAHUB_ACCESS'],
  ['identity', MEMORIAHUB_IDENTITY, 'MEMORIAHUB_IDENTITY'],
  ['notify', MEMORIAHUB_NOTIFY, 'MEMORIAHUB_NOTIFY'],
  ['settings', MEMORIAHUB_SETTINGS, 'MEMORIAHUB_SETTINGS'],
  ['secrets', MEMORIAHUB_SECRETS, 'MEMORIAHUB_SECRETS'],
];

function isBinding(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return ['useClass', 'useExisting', 'useValue', 'useFactory'].some((key) => key in value);
}

function provider(token: symbol, binding: MemoriahubPortBinding<unknown>): Provider {
  return { provide: token, ...binding } as Provider;
}

/**
 * Binds the host ports to Nest's container, globally, so a slice injects `MEMORIAHUB_JOBS`,
 * `MEMORIAHUB_AI` and the rest without importing anything.
 *
 * `forRoot` throws, naming every missing required port, when the host forgot one, so a missing binding
 * fails at start-up and not at the first request.
 *
 * @example
 * ```ts
 * MemoriahubPortsModule.forRoot({
 *   ports: {
 *     prisma: { useExisting: PrismaService },
 *     jobs: { useClass: MyJobsAdapter },
 *     ai: { useClass: MyAiAdapter },
 *     objectStore: { useClass: MyStoreAdapter },
 *     access: { useClass: MyAccessAdapter },
 *     identity: { useClass: MyIdentityAdapter },
 *     notify: { useClass: MyNotifyAdapter },
 *     settings: { useClass: MySettingsAdapter },
 *     secrets: { useClass: MySecretsAdapter },
 *   },
 * });
 * ```
 *
 * @extensionPoint token
 * @stability experimental
 */
@Global()
@Module({})
export class MemoriahubPortsModule {
  /**
   * Builds the global module.
   *
   * @param options - the port bindings.
   * @returns the dynamic module.
   * @throws Error naming every required port that has no binding.
   */
  static forRoot(options: MemoriahubPortsOptions): DynamicModule {
    const bindings = (options?.ports ?? {}) as Partial<MemoriahubPortBindings>;

    const missing = REQUIRED.filter(([key]) => !isBinding(bindings[key])).map(
      ([key, , token]) => `${token} (ports.${key})`,
    );
    if (missing.length > 0) {
      throw new Error(
        `MemoriahubPortsModule.forRoot: no binding for ${missing.length === 1 ? 'port' : 'ports'} ${missing.join(
          ', ',
        )}. Every required port must be bound; see @marinoscar/memoriahub-api/ports.`,
      );
    }

    const providers: Provider[] = REQUIRED.map(([key, token]) =>
      provider(token, bindings[key] as MemoriahubPortBinding<unknown>),
    );
    providers.push(
      isBinding(bindings.events)
        ? provider(MEMORIAHUB_EVENTS, bindings.events as MemoriahubPortBinding<unknown>)
        : { provide: MEMORIAHUB_EVENTS, useFactory: () => new InProcessMemoriahubEvents() },
      isBinding(bindings.audit)
        ? provider(MEMORIAHUB_AUDIT, bindings.audit as MemoriahubPortBinding<unknown>)
        : { provide: MEMORIAHUB_AUDIT, useValue: NOOP_MEMORIAHUB_AUDIT },
      isBinding(bindings.webhooks)
        ? provider(MEMORIAHUB_WEBHOOKS, bindings.webhooks as MemoriahubPortBinding<unknown>)
        : { provide: MEMORIAHUB_WEBHOOKS, useValue: NOOP_MEMORIAHUB_WEBHOOKS },
      isBinding(bindings.metrics)
        ? provider(MEMORIAHUB_METRICS, bindings.metrics as MemoriahubPortBinding<unknown>)
        : { provide: MEMORIAHUB_METRICS, useValue: NOOP_MEMORIAHUB_METRICS },
    );

    return {
      module: MemoriahubPortsModule,
      global: true,
      imports: bindings.imports ?? [],
      providers,
      exports: [...REQUIRED.map(([, token]) => token), MEMORIAHUB_EVENTS, MEMORIAHUB_AUDIT, MEMORIAHUB_WEBHOOKS, MEMORIAHUB_METRICS],
    };
  }
}
