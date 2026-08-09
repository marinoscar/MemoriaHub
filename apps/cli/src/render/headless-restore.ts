/**
 * render/headless-restore.ts — Terminal renderer for `memoriahub backup
 * restore` (issue #321, epic #308).
 *
 * Same split as render/headless-backup.ts and headless-verify.ts: the restore
 * engine is UI-free and emits typed events; ONLY this file and the command
 * layer print. `--json` emits NDJSON, one line per event.
 */

import chalk from 'chalk';
import { ui, isTTY } from '../ui.js';
import { formatBytes } from './headless-backup.js';
import {
  RESTORE_EV,
  type RestoreEmitter,
  type RestoreItemResult,
  type RestorePlan,
  type RestoreSummary,
} from '../backup/restore-engine.js';

export interface RenderRestoreOptions {
  /** NDJSON event stream instead of human output. */
  json: boolean;
  /** Injectable sink (tests capture output; defaults to process.stdout). */
  write?: (line: string) => void;
}

/**
 * Attach terminal-output listeners to a restore emitter. Must be called before
 * runRestore() so the plan event is not missed.
 */
export function renderRestoreHeadless(
  emitter: RestoreEmitter,
  opts: RenderRestoreOptions,
): void {
  const write = opts.write ?? ((line: string): void => void process.stdout.write(line));

  if (opts.json) {
    const emitLine = (event: string, payload: unknown): void => {
      write(`${JSON.stringify({ event, ...(payload as Record<string, unknown>) })}\n`);
    };
    emitter.on(RESTORE_EV.PLAN, (p: RestorePlan) => emitLine('restore-plan', { plan: p }));
    emitter.on(RESTORE_EV.ITEM_DONE, (p: RestoreItemResult) => emitLine('restore-item-done', p));
    emitter.on(RESTORE_EV.METADATA, (p: unknown) => emitLine('restore-metadata', p));
    emitter.on(RESTORE_EV.FINISHED, (p: { summary: RestoreSummary }) =>
      emitLine('restore-finished', p),
    );
    return;
  }

  const state = { total: 0, done: 0, failed: 0 };

  function progressLine(): string {
    const pct = state.total > 0 ? Math.floor((state.done / state.total) * 100) : 0;
    return (
      `  ${state.done}/${state.total} (${pct}%)  ` +
      `${state.failed > 0 ? chalk.red(`${state.failed} failed`) : '0 failed'}`
    );
  }

  emitter.on(RESTORE_EV.PLAN, (plan: RestorePlan) => {
    printRestorePlan(plan);
    state.total = plan.totalItems;
    if (!plan.dryRun && plan.totalItems > 0) {
      ui.blank();
      ui.step(`Restoring ${plan.totalItems} item(s) with ${plan.concurrency} worker(s)…`);
    }
  });

  emitter.on(RESTORE_EV.ITEM_DONE, (result: RestoreItemResult) => {
    state.done++;
    if (result.outcome === 'failed') state.failed++;
    if (isTTY) {
      write(`\r\x1b[2K${progressLine()}`);
    } else if (state.done % 100 === 0) {
      write(`${progressLine()}\n`);
    }
  });

  emitter.on(RESTORE_EV.FINISHED, (payload: { summary: RestoreSummary }) => {
    if (isTTY && state.done > 0) write('\n');
    ui.blank();
    printRestoreSummary(payload.summary);
  });
}

/** The circle mapping + per-circle totals — also the whole of `--dry-run`. */
export function printRestorePlan(plan: RestorePlan): void {
  ui.line(
    plan.dryRun
      ? chalk.bold('Restore plan (dry run — nothing will be written)')
      : chalk.bold('Restore plan'),
  );
  ui.line(
    `  Scope        : status=present${plan.includeTrashed ? ' + trashed (restored as ACTIVE)' : ''}` +
      ' · quarantined items are never restored',
  );
  ui.line(`  Metadata     : ${plan.skipMetadata ? 'skipped (--skip-metadata)' : 'reapplied from sidecars'}`);
  ui.blank();

  if (plan.circles.length === 0) {
    ui.warn('Nothing to restore — no eligible items in this backup root.');
    return;
  }

  ui.line('  Circle mapping:');
  for (const circle of plan.circles) {
    const source = `${circle.sourceCircleName ?? '(unnamed)'} (${circle.sourceCircleId})`;
    const target =
      circle.targetCircleId === null
        ? `${circle.targetCircleName} ${chalk.yellow('(would be created)')}`
        : `${circle.targetCircleName} (${circle.targetCircleId})`;
    ui.line(`    ${source}`);
    ui.line(`      → ${target}  ${chalk.dim(`[${circle.resolution}]`)}`);
    ui.line(
      chalk.dim(
        `      ${circle.items} item(s), ${formatBytes(circle.bytes)} · ` +
          `${circle.albums} album(s), ${circle.people} person(s), ${circle.tags} tag(s)` +
          (circle.alreadyRestored > 0
            ? ` · ${circle.alreadyRestored} already restored (will be skipped)`
            : ''),
      ),
    );
  }

  ui.blank();
  ui.line(
    `  Totals       : ${plan.totalItems} item(s), ${formatBytes(plan.totalBytes)}` +
      (plan.alreadyRestored > 0 ? ` (${plan.alreadyRestored} already restored)` : ''),
  );

  if (plan.dryRun) {
    ui.blank();
    ui.info('Dry run — no circles were created, no bytes uploaded, no metadata written.');
  }
}

/** Final report: counts, failures with reasons, and the enrichment reminder. */
export function printRestoreSummary(summary: RestoreSummary): void {
  if (summary.dryRun) return;

  ui.line(chalk.bold('Restore summary'));
  ui.line(`  Uploaded         : ${summary.uploaded} item(s), ${formatBytes(summary.bytesUploaded)}`);
  ui.line(`  Skipped (exists) : ${summary.skippedExisting}`);
  ui.line(`  Metadata applied : ${summary.metadataApplied} item(s)`);
  ui.line(
    `  Dimensions       : ${summary.tagLinks} tag link(s), ${summary.albumLinks} album link(s) ` +
      `(${summary.albumsCreated} album(s) created), ${summary.peopleLinks} person link(s), ` +
      `${summary.archived} re-archived`,
  );
  if (summary.circlesCreated > 0) {
    ui.line(`  Circles created  : ${summary.circlesCreated}`);
  }
  ui.line(
    `  Failed           : ${summary.failed > 0 ? chalk.red(String(summary.failed)) : '0'}`,
  );
  ui.line(`  Duration         : ${(summary.durationMs / 1000).toFixed(1)}s`);

  if (summary.failures.length > 0) {
    ui.blank();
    ui.warn(`${summary.failures.length} failure(s):`);
    for (const failure of summary.failures.slice(0, 20)) {
      ui.line(
        `  ${chalk.red('✗')} ${failure.relPath ?? failure.scope}  ` +
          chalk.dim(`${failure.scope}: ${failure.error}`.slice(0, 110)),
      );
    }
    if (summary.failures.length > 20) {
      ui.dim(`  …and ${summary.failures.length - 20} more.`);
    }
    ui.blank();
    ui.info('Re-run `memoriahub backup restore --root <dir>` — restored items are skipped, only the rest retry.');
  }

  ui.blank();
  ui.info(
    'Detected faces are NOT restorable — they will be re-detected by enrichment, ' +
      'along with thumbnails, AI tagging and duplicate detection. Expect the job ' +
      'queue to churn for a while (watch it at /admin/settings/jobs).',
  );
}
