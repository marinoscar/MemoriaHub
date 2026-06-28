/**
 * commands/jobs.ts — `memoriahub jobs` command.
 *
 * Live job queue dashboard showing server load, ETA, and per-type stats.
 * Requires an admin PAT with jobs:read permission.
 *
 * Usage:
 *   memoriahub jobs                     # Ink TUI (TTY only)
 *   memoriahub jobs --once              # One snapshot, plain text
 *   memoriahub jobs --json              # Raw JSON output
 *   memoriahub jobs --interval 10       # Custom polling interval (TUI)
 *   memoriahub jobs --window 14         # History window in days
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { requireConfig } from '../config.js';
import { ApiClient, ApiError } from '../api.js';
import { ui, isTTY } from '../ui.js';
import { formatDuration } from '../format-duration.js';

interface JobsOptions {
  interval: string;
  once: boolean;
  json: boolean;
  window: string;
}

export function jobsCommand(): Command {
  const cmd = new Command('jobs');
  cmd
    .alias('queue')
    .description('Live job queue dashboard (server load, ETA)')
    .option('--interval <sec>', 'Polling interval in seconds', '5')
    .option('--once', 'Print one snapshot and exit (no Ink TUI)')
    .option('--json', 'Print raw JSON and exit')
    .option('--window <days>', 'Window for history stats in days', '7')
    .action(async (opts: JobsOptions) => {
      // 1. Load config
      const config = requireConfig();
      const api = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });

      // 2. Parse window
      const windowDays = parseInt(opts.window ?? '7', 10);

      // 3. --json mode
      if (opts.json) {
        let data;
        try {
          data = await api.getJobInsights(windowDays);
        } catch (err) {
          if (err instanceof ApiError && err.status === 403) {
            ui.error('This command requires an admin access token (jobs:read).');
            process.exit(1);
          }
          const msg = err instanceof Error ? err.message : String(err);
          ui.error(`Failed to fetch job insights: ${msg}`);
          process.exit(1);
        }
        console.log(JSON.stringify(data, null, 2));
        process.exit(0);
      }

      // 4. --once or non-TTY mode (headless snapshot)
      if (opts.once || !isTTY) {
        let data;
        try {
          data = await api.getJobInsights(windowDays);
        } catch (err) {
          if (err instanceof ApiError && err.status === 403) {
            ui.error('This command requires an admin access token (jobs:read).');
            process.exit(1);
          }
          const msg = err instanceof Error ? err.message : String(err);
          ui.error(`Failed to fetch job insights: ${msg}`);
          process.exit(1);
        }

        // Compute how long ago the data was computed
        const ageMs = Date.now() - new Date(data.computedAt).getTime();
        const ageSec = Math.round(ageMs / 1000);

        // Header line
        const header = `MemoriaHub Job Queue  ·  window: ${windowDays}d  ·  computed ${ageSec}s ago`;
        process.stdout.write(chalk.bold(header) + '\n\n');

        // KPI line
        const live = data.live;
        const etcDisplay = data.eta.etaMs !== null ? formatDuration(data.eta.etaMs) : 'n/a';
        const avgDisplay = formatDuration(data.history.overall.avgMs);
        const kpiParts = [
          `Pending: ${chalk.cyan(String(live.pending))}`,
          `Running: ${chalk.cyan(String(live.running))}`,
          `Failed: ${live.failed > 0 ? chalk.red(String(live.failed)) : String(live.failed)}`,
          `Rate-limited: ${live.rateLimited > 0 ? chalk.yellow(String(live.rateLimited)) : String(live.rateLimited)}`,
          `Backing off: ${live.scheduled > 0 ? chalk.yellow(String(live.scheduled)) : String(live.scheduled)}`,
          `Retried: ${String(live.retried)}`,
          `ETC: ${etcDisplay}`,
          `Avg: ${avgDisplay}`,
        ];
        process.stdout.write(kpiParts.join('  ') + '\n\n');

        // Per-type table
        // Build a merged map of type → { pending, running, failed, avgMs, p95Ms, throughputPerMin, etcMs }
        const typeMap = new Map<string, {
          pending: number;
          running: number;
          failed: number;
          avgMs: number;
          p95Ms: number;
          throughputPerMin: number;
          etcMs: number | null;
        }>();

        // Seed from live.byType
        for (const entry of live.byType) {
          typeMap.set(entry.type, {
            pending: entry.pending,
            running: entry.running,
            failed: entry.failed,
            avgMs: 0,
            p95Ms: 0,
            throughputPerMin: 0,
            etcMs: null,
          });
        }

        // Merge history.byType
        for (const entry of data.history.byType) {
          const existing = typeMap.get(entry.type);
          if (existing) {
            existing.avgMs = entry.avgMs;
            existing.p95Ms = entry.p95Ms;
            existing.throughputPerMin = entry.throughputPerMin;
          } else {
            typeMap.set(entry.type, {
              pending: 0,
              running: 0,
              failed: 0,
              avgMs: entry.avgMs,
              p95Ms: entry.p95Ms,
              throughputPerMin: entry.throughputPerMin,
              etcMs: null,
            });
          }
        }

        // Merge eta.perType
        for (const entry of data.eta.perType) {
          const existing = typeMap.get(entry.type);
          if (existing) {
            existing.etcMs = entry.etcMs;
          } else {
            typeMap.set(entry.type, {
              pending: entry.remaining,
              running: 0,
              failed: 0,
              avgMs: entry.avgMs ?? 0,
              p95Ms: 0,
              throughputPerMin: 0,
              etcMs: entry.etcMs,
            });
          }
        }

        // Sort by (pending + running) descending
        const sortedEntries = Array.from(typeMap.entries()).sort(
          ([, a], [, b]) => (b.pending + b.running) - (a.pending + a.running),
        );

        const table = new Table({
          head: ['Type', 'Queued', 'Avg', 'p95', 'Thr/min', 'ETC'],
          style: { head: [], border: [] },
        });

        for (const [type, stats] of sortedEntries) {
          const queued = stats.pending + stats.running;
          const etc = stats.etcMs !== null ? formatDuration(stats.etcMs) : 'n/a';

          let typeLabel: string;
          let queuedLabel: string;
          if (stats.failed > 0) {
            typeLabel = chalk.red(type);
            queuedLabel = chalk.red(String(queued));
          } else if (queued > 0) {
            typeLabel = chalk.cyan(type);
            queuedLabel = chalk.cyan(String(queued));
          } else {
            typeLabel = chalk.dim(type);
            queuedLabel = chalk.dim(String(queued));
          }

          table.push([
            typeLabel,
            queuedLabel,
            formatDuration(stats.avgMs),
            formatDuration(stats.p95Ms),
            stats.throughputPerMin > 0 ? stats.throughputPerMin.toFixed(2) : '—',
            etc,
          ]);
        }

        process.stdout.write(table.toString() + '\n');
        process.exit(0);
      }

      // 5. TTY + interactive: launch Ink TUI dashboard
      const intervalMs = parseInt(opts.interval ?? '5', 10) * 1000;
      const mod = await import('../tui/JobsDashboard.js') as {
        renderJobsDashboard: (opts: { api: ApiClient; intervalMs: number; windowDays: number }) => Promise<void>;
      };
      await mod.renderJobsDashboard({ api, intervalMs, windowDays });
    });

  return cmd;
}
