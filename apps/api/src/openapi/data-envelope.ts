// =============================================================================
// The `{ data: … }` response envelope (epic #414, phase 6)
// =============================================================================
//
// The response-shape audit turned up something bigger than the handful of
// endpoints the epic named: `TransformInterceptor` is registered as a GLOBAL
// `APP_INTERCEPTOR`, and it wraps every handler return value in
// `{ data, meta: { timestamp } }` unless the handler already returned an object
// carrying a `data` key.
//
// So the drift was not "a few controllers document the inner type" — it was
// nearly every controller, because `@ApiResponse({ type: Dto })` describes what
// the handler returns and the interceptor changes that afterwards. Fixing it by
// editing ~70 controllers would be a large, error-prone sweep that the next new
// endpoint immediately reopens.
//
// Applying the same transformation to the document that the interceptor applies
// to the response closes it permanently: a handler documented as returning
// `Dto` is published as `{ data: Dto }`, and a handler that already returns
// `{ data: Dto }` is published unchanged, exactly mirroring the interceptor's
// own passthrough rule.
//
// WHAT IS DELIBERATELY LEFT ALONE
//   * Non-2xx responses — errors are written by `HttpExceptionFilter` straight
//     to the reply, bypassing every interceptor, so they are NOT enveloped.
//   * Responses with no `application/json` schema — `204`, redirects, and the
//     byte-proxy / SSE / CSV-export routes that take `@Res()` and write the
//     reply themselves. None of those declare a JSON schema, so skipping
//     schemaless responses is exactly the right filter and needs no allowlist.
//   * Schemas that already carry a `data` property, resolved through `$ref`.
// =============================================================================

import { MutableDocument, forEachOperation } from './types';

type SchemaLike = Record<string, unknown>;

const META_SCHEMA = {
  type: 'object',
  description:
    'Present when the endpoint supplies it (pagination) or when the global response interceptor ' +
    'adds it (`{ timestamp }`). Not every response carries one.',
  additionalProperties: true,
} as const;

/**
 * Wraps every documented 2xx JSON response in the envelope the global
 * interceptor produces.
 */
export function applyDataEnvelope(document: MutableDocument): MutableDocument {
  const schemas = ((document.components as SchemaLike | undefined)?.schemas ??
    {}) as Record<string, SchemaLike>;

  forEachOperation(document, (operation) => {
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (!/^2\d\d$/.test(status)) continue;

      const json = (response as SchemaLike | undefined)?.['content'] as
        | Record<string, { schema?: SchemaLike }>
        | undefined;
      const media = json?.['application/json'];
      const schema = media?.schema;
      if (!media || !schema) continue;

      if (declaresDataProperty(schema, schemas)) continue;

      media.schema = {
        type: 'object',
        required: ['data'],
        properties: { data: schema, meta: META_SCHEMA },
      };
    }
  });

  return document;
}

/**
 * Whether a schema already describes the envelope.
 *
 * `$ref` is followed one level into `components.schemas`, because a DTO named
 * for the whole envelope (`{ data: … }` as a single declared type) is
 * indistinguishable from an inner type until it is resolved — and double-
 * wrapping one would publish `{ data: { data: … } }`, a shape the server never
 * sends.
 *
 * Anything that is not a plain object schema or a resolvable local `$ref`
 * (`allOf`, `oneOf`, an external ref) is treated as "unknown", and unknown
 * schemas are left untouched rather than guessed at.
 */
function declaresDataProperty(
  schema: SchemaLike,
  schemas: Record<string, SchemaLike>,
  depth = 0,
): boolean {
  if (depth > 2) return true; // Cyclic or unexpectedly deep: do not touch it.

  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const name = ref.startsWith('#/components/schemas/')
      ? ref.slice('#/components/schemas/'.length)
      : null;
    const target = name ? schemas[name] : undefined;
    // An unresolvable ref is "unknown" — report true so the caller skips it.
    return target ? declaresDataProperty(target, schemas, depth + 1) : true;
  }

  if (schema['allOf'] || schema['oneOf'] || schema['anyOf']) return true;

  const properties = schema['properties'];
  if (properties && typeof properties === 'object') {
    return 'data' in (properties as Record<string, unknown>);
  }

  return false;
}
