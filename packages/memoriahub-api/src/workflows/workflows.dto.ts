import { createZodDto } from 'nestjs-zod';
import {
  createWorkflowSchema,
  updateWorkflowSchema,
  listWorkflowsQuerySchema,
  previewWorkflowSchema,
  approveRunSchema,
  createRunSchema,
  listRunItemsQuerySchema,
  listRunsQuerySchema,
  listAdminWorkflowRunsQuerySchema,
  listAdminWorkflowsQuerySchema,
} from '@marinoscar/memoriahub-contract/workflows';

/**
 * The `CreateWorkflowDto` request or response shape, built from its contract schema `createWorkflowSchema`.
 *
 * @stability experimental
 */
export class CreateWorkflowDto extends createZodDto(createWorkflowSchema) {}

/**
 * The `UpdateWorkflowDto` request or response shape, built from its contract schema `updateWorkflowSchema`.
 *
 * @stability experimental
 */
export class UpdateWorkflowDto extends createZodDto(updateWorkflowSchema) {}

/**
 * The `ListWorkflowsQueryDto` request or response shape, built from its contract schema `listWorkflowsQuerySchema`.
 *
 * @stability experimental
 */
export class ListWorkflowsQueryDto extends createZodDto(listWorkflowsQuerySchema) {}

/**
 * The `PreviewWorkflowDto` request or response shape, built from its contract schema `previewWorkflowSchema`.
 *
 * @stability experimental
 */
export class PreviewWorkflowDto extends createZodDto(previewWorkflowSchema) {}

/**
 * The `ApproveRunDto` request or response shape, built from its contract schema `approveRunSchema`.
 *
 * @stability experimental
 */
export class ApproveRunDto extends createZodDto(approveRunSchema) {}

/**
 * The `CreateRunDto` request or response shape, built from its contract schema `createRunSchema`.
 *
 * @stability experimental
 */
export class CreateRunDto extends createZodDto(createRunSchema) {}

/**
 * The `ListRunItemsQueryDto` request or response shape, built from its contract schema `listRunItemsQuerySchema`.
 *
 * @stability experimental
 */
export class ListRunItemsQueryDto extends createZodDto(listRunItemsQuerySchema) {}

/**
 * The `ListRunsQueryDto` request or response shape, built from its contract schema `listRunsQuerySchema`.
 *
 * @stability experimental
 */
export class ListRunsQueryDto extends createZodDto(listRunsQuerySchema) {}

/**
 * The `ListAdminWorkflowRunsQueryDto` request or response shape, built from its contract schema `listAdminWorkflowRunsQuerySchema`.
 *
 * @stability experimental
 */
export class ListAdminWorkflowRunsQueryDto extends createZodDto(listAdminWorkflowRunsQuerySchema) {}

/**
 * The `ListAdminWorkflowsQueryDto` request or response shape, built from its contract schema `listAdminWorkflowsQuerySchema`.
 *
 * @stability experimental
 */
export class ListAdminWorkflowsQueryDto extends createZodDto(listAdminWorkflowsQuerySchema) {}

