import { createZodDto } from 'nestjs-zod';
import {
  acceptLocationSuggestionSchema,
  bulkResolveLocationSuggestionsSchema,
  listLocationSuggestionRunItemsQuerySchema,
  locationSuggestionQuerySchema,
} from '@marinoscar/memoriahub-contract/location';

/**
 * Query of `GET /api/media/location-suggestions`.
 *
 * @stability experimental
 */
export class LocationSuggestionQueryDto extends createZodDto(locationSuggestionQuerySchema) {}

/**
 * Body of `POST /api/media/location-suggestions/:id/accept`.
 *
 * @stability experimental
 */
export class AcceptLocationSuggestionDto extends createZodDto(acceptLocationSuggestionSchema) {}

/**
 * Body of the two bulk accept and reject endpoints.
 *
 * @stability experimental
 */
export class BulkResolveLocationSuggestionsDto extends createZodDto(bulkResolveLocationSuggestionsSchema) {}

/**
 * Query of the run items list of the deprecated location-suggestion-runs alias.
 *
 * @stability experimental
 */
export class ListLocationSuggestionRunItemsQueryDto extends createZodDto(listLocationSuggestionRunItemsQuerySchema) {}
