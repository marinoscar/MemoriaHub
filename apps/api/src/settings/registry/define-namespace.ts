// =============================================================================
// Declaring a MemoriaHub system settings namespace (RETRO-B3, #614)
// =============================================================================
//
// A namespace is declared ONCE: a complete zod object (the stored shape, every
// bound on it) and the defaults. Everything the platform registry asks for
// beyond that is derived here, the same way for every namespace:
//
//   patch / wire-patch  the stored shape with every field optional, recursively
//                       (an object field recurses; a leaf, a nullable object, an
//                       array or a record stays whole and gains `.optional()`)
//   put / response      the stored shape
//   read                every LEAF is salvaged on its own: a stored sub-object
//                       that lacks one field keeps the others and takes the
//                       default for the missing one (what `.default()` on each
//                       leaf did before RETRO-B3)
//   merge               PATCH semantics, field by field: absent keeps the stored
//                       value; an object field merges; a record merges key by
//                       key; anything else (arrays, scalars, nullable objects,
//                       an explicit null on a nullable field) replaces
//
// A namespace that needs a different rule passes `keepOnNull` (paths where an
// explicit null leaves the stored value alone) or its own `merge`.
// =============================================================================

import type { SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

type AnyObject = z.ZodObject<z.ZodRawShape>;
type Json = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** `schema` with every field optional, recursing only through plain object fields. */
export function deepPartial(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries((schema as AnyObject).shape).map(([key, field]) => [
        key,
        deepPartial(field as z.ZodType).optional(),
      ]),
    );
    return z.object(shape);
  }
  return schema;
}

/**
 * `stored` projected onto `schema`, leaf by leaf: a leaf that fails its own
 * schema (or is absent) takes a clone of the default. Never throws.
 */
export function readDeep(schema: AnyObject, stored: unknown, defaults: Json): Json {
  const source = isPlainObject(stored) ? stored : {};
  const out: Json = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    if (field instanceof z.ZodObject && isPlainObject(defaults[key])) {
      out[key] = readDeep(field as AnyObject, source[key], defaults[key] as Json);
      continue;
    }
    const parsed = (field as z.ZodType).safeParse(source[key]);
    out[key] = parsed.success ? parsed.data : structuredClone(defaults[key]);
  }
  return out;
}

/** Field-by-field PATCH merge; see the header for the rules. */
export function mergeDeep(
  schema: AnyObject,
  current: unknown,
  patch: unknown,
  keepOnNull: ReadonlySet<string>,
  path = '',
): Json {
  const cur = isPlainObject(current) ? current : {};
  const pat = isPlainObject(patch) ? patch : {};
  const out: Json = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const here = path ? `${path}.${key}` : key;
    const incoming = pat[key];
    if (incoming === undefined) {
      out[key] = cur[key];
    } else if (field instanceof z.ZodObject) {
      out[key] = mergeDeep(field as AnyObject, cur[key], incoming, keepOnNull, here);
    } else if (field instanceof z.ZodRecord) {
      out[key] = { ...(isPlainObject(cur[key]) ? cur[key] : {}), ...(incoming as Json) };
    } else if (incoming === null && keepOnNull.has(here)) {
      out[key] = cur[key];
    } else {
      out[key] = incoming;
    }
  }
  return out;
}

export interface SystemNamespaceSpec<K extends string, S extends AnyObject> {
  readonly key: K;
  readonly description: string;
  /** The complete stored shape, every bound on it. No `.default()`. */
  readonly schema: S;
  readonly defaults: z.infer<S>;
  /** Dot paths where an explicit `null` keeps the stored value (`??` semantics). */
  readonly keepOnNull?: readonly string[];
}

/** Declares a system namespace from its stored shape and defaults. */
export function defineSystemNamespace<K extends string, S extends AnyObject>(
  spec: SystemNamespaceSpec<K, S>,
): SystemSettingsNamespace<K, z.infer<S>, Json> {
  const keep = new Set(spec.keepOnNull ?? []);
  const patch = deepPartial(spec.schema);
  return {
    key: spec.key,
    description: spec.description,
    storedSchema: spec.schema as unknown as z.ZodType<z.infer<S>>,
    patchSchema: patch,
    putSchema: spec.schema,
    wirePatchSchema: patch,
    responseSchema: spec.schema,
    defaults: spec.defaults,
    requiredOnPut: false,
    read: (stored) => readDeep(spec.schema, stored, spec.defaults as Json) as z.infer<S>,
    merge: (current, patchBody) =>
      mergeDeep(spec.schema, current, patchBody, keep) as z.infer<S>,
  };
}
