import { Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * Pagination style a listing endpoint uses. See the `meta` shapes below —
 * `GET /api/media` is the one endpoint that supports both, selected by whether
 * the caller sends `page`.
 */
export type DataResponseMeta = 'offset' | 'keyset';

export interface ApiDataResponseOptions {
  status?: number;
  description?: string;
  /** Wrap the model in an array: `{ data: [T] }`. */
  isArray?: boolean;
  /** Emit a sibling `meta` object alongside `data`. */
  meta?: DataResponseMeta;
}

const OFFSET_META_SCHEMA = {
  type: 'object',
  description: 'Offset pagination. Backed by a `COUNT(*)`, so it can report a total.',
  required: ['page', 'pageSize', 'totalItems', 'totalPages'],
  properties: {
    page: { type: 'integer', description: 'One-based page number.', example: 1 },
    pageSize: { type: 'integer', example: 50 },
    totalItems: { type: 'integer', example: 1284 },
    totalPages: { type: 'integer', example: 26 },
  },
} as const;

const KEYSET_META_SCHEMA = {
  type: 'object',
  description:
    'Keyset pagination. Runs no count query; pass `nextCursor` back as `cursor` to fetch the ' +
    'following page.',
  required: ['pageSize', 'nextCursor', 'hasMore'],
  properties: {
    pageSize: { type: 'integer', example: 50 },
    nextCursor: {
      type: 'string',
      nullable: true,
      description: 'Opaque cursor for the next page, or null when the last page has been reached.',
    },
    hasMore: { type: 'boolean', example: true },
  },
} as const;

/**
 * Documents a response that wraps its payload in the `{ data: … }` envelope.
 *
 * Exists because the two were routinely out of sync: a handler returning
 * `{ data: { providers: [...] } }` documented with `@ApiResponse({ type: Dto })`
 * advertises the bare inner object, so a generated client, a Postman import, or
 * anyone reading the sample gets a shape the server never sends. Declaring the
 * envelope once, here, removes the opportunity to describe it wrongly.
 *
 * Use plain `@ApiResponse` for the handful of endpoints that genuinely return
 * an unwrapped body — the point is accuracy, not uniformity.
 *
 * @example
 * @ApiDataResponse(AuthProvidersResponseDto, { description: 'Enabled providers' })
 *
 * @example
 * @ApiDataResponse(MediaItemDto, { isArray: true, meta: 'keyset' })
 */
export function ApiDataResponse(
  model: Type<unknown>,
  options: ApiDataResponseOptions = {},
) {
  const { status = 200, description, isArray = false, meta } = options;

  const dataSchema = isArray
    ? { type: 'array' as const, items: { $ref: getSchemaPath(model) } }
    : { $ref: getSchemaPath(model) };

  const properties: Record<string, unknown> = { data: dataSchema };
  const required = ['data'];

  if (meta) {
    properties.meta = meta === 'offset' ? OFFSET_META_SCHEMA : KEYSET_META_SCHEMA;
    required.push('meta');
  }

  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status,
      description,
      // Cast because `SchemaObject.properties` is typed against @nestjs/swagger's
      // own node types, which the plain JSON-Schema literals above satisfy
      // structurally but cannot be inferred as.
      schema: { type: 'object', required, properties } as SchemaObject,
    }),
  );
}
