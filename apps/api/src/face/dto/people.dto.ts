import { createZodDto } from 'nestjs-zod';
import { listPeopleQuerySchema, createPersonSchema, updatePersonSchema, assignFacesSchema, clusterSchema, listUnassignedFacesQuerySchema, bulkPeopleSchema } from '@marinoscar/memoriahub-contract/face';

export { listPeopleQuerySchema, createPersonSchema, updatePersonSchema, assignFacesSchema, clusterSchema, listUnassignedFacesQuerySchema, bulkPeopleSchema };

export class ListPeopleQueryDto extends createZodDto(listPeopleQuerySchema) {}

export class CreatePersonDto extends createZodDto(createPersonSchema) {}

export class UpdatePersonDto extends createZodDto(updatePersonSchema) {}

export class AssignFacesDto extends createZodDto(assignFacesSchema) {}

export class ClusterDto extends createZodDto(clusterSchema) {}

export class ListUnassignedFacesQueryDto extends createZodDto(listUnassignedFacesQuerySchema) {}

export class BulkPeopleDto extends createZodDto(bulkPeopleSchema) {}

export class BulkFacesDto extends createZodDto(bulkPeopleSchema) {}

export class PurgeArchivedFacesDto extends createZodDto(clusterSchema) {}
