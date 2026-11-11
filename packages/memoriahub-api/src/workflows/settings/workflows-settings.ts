import type { MemoriahubSettingsPort } from '../../ports/index.js';

// =============================================================================
// The workflow settings the engine reads (RETRO-J9, #622)
// =============================================================================
//
// Two system namespaces: `features` (the `workflows` flag, the kill switch `WORKFLOWS_ENABLED=false` overrides it)
// and `workflows` (the limits, the preview and hard-delete policy, the trigger switches, the retention window).
// `readWorkflowSettings` answers both as one object, the shape the engine's code always read, so a host that binds
// `MEMORIAHUB_SETTINGS` needs no workflow-specific adapter. Reads go through the port (the host caches them).
// =============================================================================

/**
 * The `workflows` system settings namespace.
 *
 * @stability experimental
 */
export interface WorkflowsSettings {
  /** Hard cap on items materialized per run. */
  maxItemsPerRun?: number;
  /** Items per `workflow_execute_batch` job. */
  batchSize?: number;
  /** Simultaneous non-terminal runs allowed app-wide. */
  maxConcurrentRuns?: number;
  /** Whether every manual run needs approval. */
  requirePreview?: boolean;
  /** Unlocks the `hard_delete` action. */
  allowHardDelete?: boolean;
  /** Workflow cap per circle. */
  maxWorkflowsPerCircle?: number;
  /** Hours an `awaiting_approval` run is kept. */
  previewTtlHours?: number;
  /** Master switches of the unattended triggers. */
  triggers?: { onEnrichment?: boolean; scheduled?: boolean };
  /** Tightest cron cadence a scheduled workflow may use. */
  scheduleMinIntervalMinutes?: number;
}

/**
 * The settings the engine reads, as one object.
 *
 * @stability experimental
 */
export interface ResolvedWorkflowSettings {
  /** The `features` namespace (flags by name). */
  features: Record<string, unknown>;
  /** The `workflows` namespace. */
  workflows: WorkflowsSettings;
}

/**
 * Reads the two namespaces through the settings port.
 *
 * @param settings - the settings port.
 * @stability experimental
 */
export async function readWorkflowSettings(settings: MemoriahubSettingsPort): Promise<ResolvedWorkflowSettings> {
  const [features, workflows] = await Promise.all([
    settings.readSystem<Record<string, unknown> | undefined>('features'),
    settings.readSystem<WorkflowsSettings | undefined>('workflows'),
  ]);
  return { features: features.value ?? {}, workflows: workflows.value ?? {} };
}

/**
 * Media Workflow Automation is on: `features.workflows` and not `WORKFLOWS_ENABLED=false`.
 *
 * @param settings - the resolved settings.
 * @stability experimental
 */
export function isWorkflowsEnabled(settings: Pick<ResolvedWorkflowSettings, 'features'>): boolean {
  return settings.features?.['workflows'] === true && process.env['WORKFLOWS_ENABLED'] !== 'false';
}
