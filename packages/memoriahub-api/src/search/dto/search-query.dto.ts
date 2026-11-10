import { createZodDto } from 'nestjs-zod';
import { peopleFilterValueSchema, nearFilterValueSchema, dateRangeFilterValueSchema, searchQuerySchema, type PeopleFilterValue, type NearFilterValue, type DateRangeFilterValue } from '@marinoscar/memoriahub-contract/search';

export { peopleFilterValueSchema, nearFilterValueSchema, dateRangeFilterValueSchema, searchQuerySchema };
export type { PeopleFilterValue, NearFilterValue, DateRangeFilterValue };

/**
 * The body of `POST /api/search`.
 *
 * @stability experimental
 */
export class SearchQueryDto extends createZodDto(searchQuerySchema) {}
