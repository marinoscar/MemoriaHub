import { createZodDto } from 'nestjs-zod';
import { folderSchema, mediaSyncConfigSchema, inventoryFolderSchema, inventorySchema, statsSchema, registerDeviceSchema, targetOwnerSchema, updateConfigSchema, commandSchema, failedSampleSchema, perFolderSchema, checkinRunSchema, checkinSchema, uploadDiagnosticsSchema, mediaSyncListRunsQuerySchema, listReportsQuerySchema, deviceViewSchema, configResultSchema, checkinResultSchema, runViewSchema, reportSummaryViewSchema, reportViewSchema, reportCreatedViewSchema, type MediaSyncConfig, type InventoryFolder, type MediaSyncStats, type RegisterDeviceInput, type TargetOwner, type UpdateConfigInput, type CommandInput, type CheckinRunInput, type CheckinInput, type UploadDiagnosticsInput, type DeviceView, type ConfigResult, type CheckinResult, type RunView, type ReportSummaryView, type ReportView, type ReportCreatedView } from '@marinoscar/memoriahub-contract/media-sync';

export { folderSchema, mediaSyncConfigSchema, inventoryFolderSchema, inventorySchema, statsSchema, registerDeviceSchema, targetOwnerSchema, updateConfigSchema, commandSchema, failedSampleSchema, perFolderSchema, checkinRunSchema, checkinSchema, uploadDiagnosticsSchema, mediaSyncListRunsQuerySchema as listRunsQuerySchema, listReportsQuerySchema, deviceViewSchema, configResultSchema, checkinResultSchema, runViewSchema, reportSummaryViewSchema, reportViewSchema, reportCreatedViewSchema };
export type { MediaSyncConfig, InventoryFolder, MediaSyncStats, RegisterDeviceInput, TargetOwner, UpdateConfigInput, CommandInput, CheckinRunInput, CheckinInput, UploadDiagnosticsInput, DeviceView, ConfigResult, CheckinResult, RunView, ReportSummaryView, ReportView, ReportCreatedView };

export class MediaSyncConfigDto extends createZodDto(mediaSyncConfigSchema) {}

export class RegisterDeviceDto extends createZodDto(registerDeviceSchema) {}

export class UpdateConfigDto extends createZodDto(updateConfigSchema) {}

export class CommandDto extends createZodDto(commandSchema) {}

export class CheckinDto extends createZodDto(checkinSchema) {}

export class UploadDiagnosticsDto extends createZodDto(uploadDiagnosticsSchema) {}

export class ListRunsQueryDto extends createZodDto(mediaSyncListRunsQuerySchema) {}

export class ListReportsQueryDto extends createZodDto(listReportsQuerySchema) {}

export class DeviceViewDto extends createZodDto(deviceViewSchema) {}

export class ConfigResultDto extends createZodDto(configResultSchema) {}

export class CheckinResultDto extends createZodDto(checkinResultSchema) {}

export class RunViewDto extends createZodDto(runViewSchema) {}

export class ReportSummaryViewDto extends createZodDto(reportSummaryViewSchema) {}

export class ReportViewDto extends createZodDto(reportViewSchema) {}

export class ReportCreatedViewDto extends createZodDto(reportCreatedViewSchema) {}
