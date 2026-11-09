// =============================================================================
// OpenAPI: the owner-scope parameters (RETRO-I3, #573)
// =============================================================================
//
// The routes' DTOs keep `circleId`; `OwnerScopeParamsInterceptor`
// (`platform/sharing/owner-scope-params.ts`) rewrites `ownerGroupId` and
// `scope=me` into it at runtime. This pass documents that on every operation
// that has a `circleId`, query parameter or JSON body property alike:
//
//   - `circleId` is marked `deprecated` and no longer required;
//   - `ownerGroupId` (uuid) and `scope` (`me`) are added next to it.
//
// An operation that already declares its own `scope` keeps it; `me` is added
// to its enum when it has one. Idempotent: a second run changes nothing.
// =============================================================================

import { forEachOperation, type MutableDocument } from '@marinoscar/platform-api/host';

const SCOPE_TEXT =
  'Owner scope of the call: `ownerGroupId` (a shared library) or `scope=me` (your own personal library). ' +
  '`circleId` is the deprecated name of `ownerGroupId`, accepted for one release.';

const OWNER_GROUP_ID_SCHEMA = { type: 'string', format: 'uuid', description: 'A shared library (group) id. ' + SCOPE_TEXT };
const SCOPE_SCHEMA = { type: 'string', enum: ['me'], description: '`me`: your own personal library. ' + SCOPE_TEXT };

type Json = Record<string, unknown>;

interface Parameter extends Json {
  name?: string;
  in?: string;
  required?: boolean;
  deprecated?: boolean;
  description?: string;
  schema?: Json;
}

function deprecateCircleIdDescription(text: unknown): string {
  const base = typeof text === 'string' && text.length > 0 ? `${text} ` : '';
  return base.includes('Deprecated') ? base.trim() : `${base}Deprecated: use \`ownerGroupId\` or \`scope=me\`.`;
}

/** Adds `me` to an existing `scope` enum, if it has one. */
function addMeToEnum(schema: Json | undefined): void {
  const values = schema?.enum;
  if (Array.isArray(values) && !values.includes('me')) values.push('me');
}

function applyToParameters(parameters: Parameter[]): void {
  const circle = parameters.find((p) => p.in === 'query' && p.name === 'circleId');
  if (!circle) return;
  circle.deprecated = true;
  circle.required = false;
  circle.description = deprecateCircleIdDescription(circle.description);
  if (!parameters.some((p) => p.in === 'query' && p.name === 'ownerGroupId')) {
    parameters.push({ name: 'ownerGroupId', in: 'query', required: false, description: OWNER_GROUP_ID_SCHEMA.description, schema: { type: 'string', format: 'uuid' } });
  }
  const scope = parameters.find((p) => p.in === 'query' && p.name === 'scope');
  if (scope) addMeToEnum(scope.schema);
  else parameters.push({ name: 'scope', in: 'query', required: false, description: SCOPE_SCHEMA.description, schema: { type: 'string', enum: ['me'] } });
}

function applyToSchema(schema: Json): void {
  const properties = schema.properties as Record<string, Json> | undefined;
  if (!properties?.circleId) return;
  properties.circleId.deprecated = true;
  properties.circleId.description = deprecateCircleIdDescription(properties.circleId.description);
  if (Array.isArray(schema.required)) {
    schema.required = (schema.required as string[]).filter((name) => name !== 'circleId');
    if ((schema.required as string[]).length === 0) delete schema.required;
  }
  properties.ownerGroupId ??= { ...OWNER_GROUP_ID_SCHEMA };
  if (properties.scope) addMeToEnum(properties.scope);
  else properties.scope = { ...SCOPE_SCHEMA, enum: [...SCOPE_SCHEMA.enum] };
}

/** Resolves a local `#/components/schemas/X` reference. */
function resolve(document: MutableDocument, schema: Json | undefined): Json | undefined {
  const ref = schema?.$ref;
  if (typeof ref !== 'string') return schema;
  const name = ref.replace('#/components/schemas/', '');
  const components = (document.components as Json | undefined)?.schemas as Record<string, Json> | undefined;
  return components?.[name];
}

/** Documents `ownerGroupId` / `scope=me` beside every `circleId`, in place. */
export function applyOwnerScopeParams(document: MutableDocument): void {
  forEachOperation(document, (operation) => {
    if (Array.isArray(operation.parameters)) applyToParameters(operation.parameters as Parameter[]);
    const content = ((operation.requestBody as Json | undefined)?.content as Record<string, Json> | undefined) ?? {};
    for (const media of Object.values(content)) {
      const schema = resolve(document, media.schema as Json | undefined);
      if (schema) applyToSchema(schema);
    }
  });
}
