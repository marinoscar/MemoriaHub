import { createZodDto } from 'nestjs-zod';
import { folderSchema, mediaSyncConfigSchema, inventoryFolderSchema, inventorySchema, statsSchema, registerDeviceSchema, targetOwnerSchema, updateConfigSchema, commandSchema, failedSampleSchema, perFolderSchema, checkinRunSchema, checkinSchema, uploadDiagnosticsSchema, mediaSyncListRunsQuerySchema, listReportsQuerySchema, deviceViewSchema, configResultSchema, checkinResultSchema, runViewSchema, reportSummaryViewSchema, reportViewSchema, reportCreatedViewSchema, type MediaSyncConfig, type InventoryFolder, type MediaSyncStats, type RegisterDeviceInput, type TargetOwner, type UpdateConfigInput, type CommandInput, type CheckinRunInput, type CheckinInput, type UploadDiagnosticsInput, type DeviceView, type ConfigResult, type CheckinResult, type RunView, type ReportSummaryView, type ReportView, type ReportCreatedView } from '@marinoscar/memoriahub-contract/media-sync';

export { folderSchema, mediaSyncConfigSchema, inventoryFolderSchema, inventorySchema, statsSchema, registerDeviceSchema, targetOwnerSchema, updateConfigSchema, commandSchema, failedSampleSchema, perFolderSchema, checkinRunSchema, checkinSchema, uploadDiagnosticsSchema, mediaSyncListRunsQuerySchema as listRunsQuerySchema, listReportsQuerySchema, deviceViewSchema, configResultSchema, checkinResultSchema, runViewSchema, reportSummaryViewSchema, reportViewSchema, reportCreatedViewSchema };
export type { MediaSyncConfig, InventoryFolder, MediaSyncStats, RegisterDeviceInput, TargetOwner, UpdateConfigInput, CommandInput, CheckinRunInput, CheckinInput, UploadDiagnosticsInput, DeviceView, ConfigResult, CheckinResult, RunView, ReportSummaryView, ReportView, ReportCreatedView };

/**
 * The `MediaSyncConfigDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class MediaSyncConfigDto extends createZodDto(mediaSyncConfigSchema) {}

/**
 * The `RegisterDeviceDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class RegisterDeviceDto extends createZodDto(registerDeviceSchema) {}

/**
 * The `UpdateConfigDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class UpdateConfigDto extends createZodDto(updateConfigSchema) {}

/**
 * The `CommandDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class CommandDto extends createZodDto(commandSchema) {}

/**
 * The `CheckinDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class CheckinDto extends createZodDto(checkinSchema) {}

/**
 * The `UploadDiagnosticsDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class UploadDiagnosticsDto extends createZodDto(uploadDiagnosticsSchema) {}

/**
 * The `ListRunsQueryDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ListRunsQueryDto extends createZodDto(mediaSyncListRunsQuerySchema) {}

/**
 * The `ListReportsQueryDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ListReportsQueryDto extends createZodDto(listReportsQuerySchema) {}

/**
 * The `DeviceViewDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class DeviceViewDto extends createZodDto(deviceViewSchema) {}

/**
 * The `ConfigResultDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ConfigResultDto extends createZodDto(configResultSchema) {}

/**
 * The `CheckinResultDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class CheckinResultDto extends createZodDto(checkinResultSchema) {}

/**
 * The `RunViewDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class RunViewDto extends createZodDto(runViewSchema) {}

/**
 * The `ReportSummaryViewDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ReportSummaryViewDto extends createZodDto(reportSummaryViewSchema) {}

/**
 * The `ReportViewDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ReportViewDto extends createZodDto(reportViewSchema) {}

/**
 * The `ReportCreatedViewDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ReportCreatedViewDto extends createZodDto(reportCreatedViewSchema) {}
