import type {
  MemoriahubSettingsNamespaceDef,
  MemoriahubSettingsPort,
  MemoriahubVersionedSettings,
} from '../ports/index.js';

/**
 * An in-memory `MEMORIAHUB_SETTINGS`: declared namespaces validated with their schema, a document
 * version that rises on every system write, and `ifMatchVersion` refused on a mismatch.
 *
 * @stability experimental
 */
export class FakeMemoriahubSettings implements MemoriahubSettingsPort {
  private readonly defs = new Map<string, MemoriahubSettingsNamespaceDef>();

  private readonly system = new Map<string, unknown>();

  private readonly user = new Map<string, unknown>();

  private version = 1;

  /** Time zones by user; a user with none gets `UTC`. */
  readonly timeZones = new Map<string, string>();

  /** Declares a namespace. */
  registerNamespace(def: MemoriahubSettingsNamespaceDef): void {
    this.defs.set(`${def.scope}:${def.name}`, def);
  }

  /** Reads a system namespace. */
  async readSystem<T>(name: string): Promise<MemoriahubVersionedSettings<T>> {
    const def = this.def('system', name);
    return { value: this.merged(def, this.system.get(name)) as T, version: this.version };
  }

  /** Patches a system namespace. */
  async patchSystem<T>(
    name: string,
    patch: Partial<T>,
    ctx: { actorUserId: string; ifMatchVersion?: number },
  ): Promise<MemoriahubVersionedSettings<T>> {
    const def = this.def('system', name);
    if (ctx.ifMatchVersion !== undefined && ctx.ifMatchVersion !== this.version) {
      throw new Error(`The settings changed since version ${ctx.ifMatchVersion}`);
    }
    const next = this.validated(def, { ...this.merged(def, this.system.get(name)), ...patch });
    this.system.set(name, next);
    this.version += 1;
    return { value: next as T, version: this.version };
  }

  /** Reads a user namespace. */
  async readUser<T>(userId: string, name: string): Promise<T> {
    const def = this.def('user', name);
    return this.merged(def, this.user.get(`${userId}:${name}`)) as T;
  }

  /** Patches a user namespace. */
  async patchUser<T>(userId: string, name: string, patch: Partial<T>): Promise<T> {
    const def = this.def('user', name);
    const next = this.validated(def, { ...this.merged(def, this.user.get(`${userId}:${name}`)), ...patch });
    this.user.set(`${userId}:${name}`, next);
    return next as T;
  }

  /** A user's zone, `UTC` when none. */
  async readUserTimeZone(userId: string): Promise<string> {
    return this.timeZones.get(userId) ?? 'UTC';
  }

  private def(scope: 'system' | 'user', name: string): MemoriahubSettingsNamespaceDef {
    const def = this.defs.get(`${scope}:${name}`);
    if (!def) throw new Error(`The ${scope} settings namespace "${name}" is not declared`);
    return def;
  }

  private merged(def: MemoriahubSettingsNamespaceDef, stored: unknown): Record<string, unknown> {
    const base = def.defaults !== null && typeof def.defaults === 'object' ? (def.defaults as Record<string, unknown>) : {};
    return { ...base, ...(stored !== null && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}) };
  }

  private validated(def: MemoriahubSettingsNamespaceDef, value: unknown): unknown {
    const parsed = def.schema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid ${def.scope} settings "${def.name}": ${parsed.error.message}`);
    return parsed.data;
  }
}
