import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  maxItemsPerRun: z.number().int().min(100).max(500000),
  batchSize: z.number().int().min(50).max(1000),
  maxConcurrentRuns: z.number().int().min(1).max(10),
  requirePreview: z.boolean(),
  allowHardDelete: z.boolean(),
  maxWorkflowsPerCircle: z.number().int().min(1).max(100),
  previewTtlHours: z.number().int().min(1).max(168),
  runHistoryRetentionDays: z.number().int().min(1).max(365),
  triggers: z.object({ onEnrichment: z.boolean(), scheduled: z.boolean() }),
  scheduleMinIntervalMinutes: z.number().int().min(60).max(10080),
});
export type WorkflowsSettingsValue = z.infer<typeof schema>;

export const WORKFLOWS_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'workflows',
  description: 'Media Workflow Automation limits, preview and hard-delete policy, trigger switches and retention.',
  schema,
  defaults: {
    maxItemsPerRun: 10000,
    batchSize: 200,
    maxConcurrentRuns: 2,
    requirePreview: true,
    allowHardDelete: false,
    maxWorkflowsPerCircle: 20,
    previewTtlHours: 24,
    runHistoryRetentionDays: 30,
    triggers: { onEnrichment: true, scheduled: true },
    scheduleMinIntervalMinutes: 60,
  },
});
