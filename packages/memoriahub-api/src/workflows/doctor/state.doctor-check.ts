import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  DOCTOR_CHECK_TIMEOUT_MS,
  doctorCheckId,
  pass,
  readSystemNamespaces,
  skip,
  warn,
} from '../../core/index.js';
import {
  MEMORIAHUB_DOCTOR,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubDoctorCheck,
  type MemoriahubDoctorOutcome as DoctorCheckOutcome,
  type MemoriahubDoctorPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import { WORKFLOW_RUN_STATUS, WORKFLOW_TRIGGER } from '../workflows.constants.js';
import type { WorkflowsDb } from '../data/workflows-db.js';

// Ported from `DoctorService.checkWorkflowsState` (key `workflows.state`).
// READ-ONLY: pure DB counts. Surfaces operational inconsistencies an admin
// should act on: an env kill-switch overriding the feature flag; runs stuck
// non-terminal with no counter progress; awaiting_approval runs past their TTL
// that the purge task should have expired; and scheduled workflows that will
// never fire because the scheduled-trigger master switch is off.

/**
 * How long a workflow run may sit non-terminal (running/evaluating) without any
 * counter progress before it's flagged as stuck. Deliberately generous: a
 * single run can legitimately churn through 150k+ items across many batch jobs.
 *
 * @stability experimental
 */
export const WORKFLOW_STUCK_MINUTES = 30;

/** The facts the workflow engine state check decides on. @stability experimental */
export interface WorkflowStateFacts {
  featureEnabled: boolean;
  envDisabled: boolean;
  stuckRuns: number;
  staleApprovalRuns: number;
  previewTtlHours: number;
  scheduledWorkflowsBlocked: number;
}

/** The status ladder of the workflow engine state check. @stability experimental */
export function decideWorkflowsState(f: WorkflowStateFacts): DoctorCheckOutcome {
  if (!f.featureEnabled) return skip('Workflows feature is disabled.');

  const warnings: string[] = [];
  const actions: string[] = [];

  if (f.envDisabled) {
    warnings.push('Feature enabled in settings but WORKFLOWS_ENABLED=false overrides it — no workflows run.');
    actions.push('Remove or set WORKFLOWS_ENABLED=true.');
  }
  if (f.stuckRuns > 0) {
    warnings.push(`${f.stuckRuns} workflow run(s) stuck non-terminal with no progress for over ${WORKFLOW_STUCK_MINUTES} min.`);
    actions.push(
      'Cancel the stuck run(s) from Admin → Workflows and check the enrichment worker/queue for wedged workflow jobs.',
    );
  }
  if (f.staleApprovalRuns > 0) {
    warnings.push(
      `${f.staleApprovalRuns} awaiting-approval run(s) are past their ${f.previewTtlHours}h TTL but not expired — the history-purge task may not be running.`,
    );
    actions.push('Verify the workflow_history_purge cron/job is running so stale approval runs expire.');
  }
  if (f.scheduledWorkflowsBlocked > 0) {
    warnings.push(
      `${f.scheduledWorkflowsBlocked} enabled scheduled workflow(s) exist but the scheduled trigger is turned off — they will never run.`,
    );
    actions.push('Enable workflows.triggers.scheduled in Admin → Workflows, or disable the scheduled workflows.');
  }

  if (warnings.length > 0) {
    return warn(warnings.join(' '), actions.join(' '), {
      stuckRuns: f.stuckRuns,
      staleApprovalRuns: f.staleApprovalRuns,
      scheduledWorkflowsBlocked: f.scheduledWorkflowsBlocked,
    });
  }
  return pass('Workflows enabled; no stuck, stale, or misconfigured runs.');
}

@Injectable()
/** The workflow engine state check. @stability experimental */
export class WorkflowsStateDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('workflows', 'state');
  readonly category = 'workflows';
  readonly label = 'Workflow engine state';
  readonly settingsPath = '/admin/settings/workflows';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    @Inject(MEMORIAHUB_DOCTOR) private readonly doctor: MemoriahubDoctorPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: WorkflowsDb,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
  ) {}

  /** Registers the check with the diagnostics port. */
  onModuleInit(): void {
    this.doctor.registerCheck(this);
  }

  /** Runs the check. */
  async run(): Promise<DoctorCheckOutcome> {
    const settings = await readSystemNamespaces(this.settings, ['features', 'workflows']);
    const base = {
      featureEnabled: settings.features?.['workflows'] === true,
      envDisabled: process.env['WORKFLOWS_ENABLED'] === 'false',
      stuckRuns: 0,
      staleApprovalRuns: 0,
      previewTtlHours: settings.workflows?.previewTtlHours ?? 24,
      scheduledWorkflowsBlocked: 0,
    };
    if (!base.featureEnabled) return decideWorkflowsState(base);

    const now = Date.now();
    const stuckCutoff = new Date(now - WORKFLOW_STUCK_MINUTES * 60_000);
    const approvalCutoff = new Date(now - base.previewTtlHours * 3_600_000);
    const scheduledTriggerOn = settings.workflows?.triggers?.scheduled !== false;

    const [stuckRuns, staleApprovalRuns, scheduledWorkflowsBlocked] = await Promise.all([
      // Runs non-terminal past the stuck window; served by (status, updatedAt).
      this.prisma.workflowRun.count({
        where: {
          status: { in: [WORKFLOW_RUN_STATUS.running, WORKFLOW_RUN_STATUS.evaluating] },
          updatedAt: { lt: stuckCutoff },
        },
      }),
      // awaiting_approval runs past their TTL: the history-purge task mirrors this predicate.
      this.prisma.workflowRun.count({
        where: { status: WORKFLOW_RUN_STATUS.awaiting_approval, updatedAt: { lt: approvalCutoff } },
      }),
      // Enabled scheduled workflows never fire while the master switch is off.
      scheduledTriggerOn
        ? Promise.resolve(0)
        : this.prisma.workflow.count({ where: { enabled: true, trigger: WORKFLOW_TRIGGER.scheduled } }),
    ]);

    return decideWorkflowsState({ ...base, stuckRuns, staleApprovalRuns, scheduledWorkflowsBlocked });
  }
}
