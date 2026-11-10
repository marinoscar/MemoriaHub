import { createZodDto } from 'nestjs-zod';
import { listPeopleQuerySchema, createPersonSchema, updatePersonSchema, assignFacesSchema, clusterSchema, listUnassignedFacesQuerySchema, bulkPeopleSchema } from '@marinoscar/memoriahub-contract/face';

export { listPeopleQuerySchema, createPersonSchema, updatePersonSchema, assignFacesSchema, clusterSchema, listUnassignedFacesQuerySchema, bulkPeopleSchema };

/**
 * The `ListPeopleQueryDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ListPeopleQueryDto extends createZodDto(listPeopleQuerySchema) {}

/**
 * The `CreatePersonDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class CreatePersonDto extends createZodDto(createPersonSchema) {}

/**
 * The `UpdatePersonDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class UpdatePersonDto extends createZodDto(updatePersonSchema) {}

/**
 * The `AssignFacesDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class AssignFacesDto extends createZodDto(assignFacesSchema) {}

/**
 * The `ClusterDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ClusterDto extends createZodDto(clusterSchema) {}

/**
 * The `ListUnassignedFacesQueryDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ListUnassignedFacesQueryDto extends createZodDto(listUnassignedFacesQuerySchema) {}

/**
 * The `BulkPeopleDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class BulkPeopleDto extends createZodDto(bulkPeopleSchema) {}

/**
 * The `BulkFacesDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class BulkFacesDto extends createZodDto(bulkPeopleSchema) {}

/**
 * The `PurgeArchivedFacesDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class PurgeArchivedFacesDto extends createZodDto(clusterSchema) {}
