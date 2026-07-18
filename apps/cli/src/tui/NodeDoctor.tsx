/**
 * tui/NodeDoctor.tsx — Ink screen for the full worker-node doctor sweep.
 *
 * Runs the exact same six-step sweep as `memoriahub node doctor`
 * (commands/node.ts's `doctorCmd()`) via the shared, React-agnostic
 * `runNodeDoctorSweep()` in ./useNodeDoctorSweep.js — see that module's header
 * comment for the full step list and rationale. This screen renders it as a
 * step-by-step running log (like the CLI's sequential `ui.step`/`ui.success`/
 * `ui.warn`/`ui.error` output, but appended as scrolling Ink text) followed by
 * the full report: the installed-vs-operational capability table (mirrors
 * `printOperationalCapabilityTable` in commands/node.ts), job-type readiness,
 * model status, and daemon liveness. Unlike the CLI command, this screen never
 * calls `process.exit()` — the pass/fail verdict is rendered as a colored
 * summary line only.
 *
 * Health classification (top checklist icons, and the collapse-to-one-line
 * behavior for the Capabilities/Job-readiness/API-Access sections below) is
 * delegated entirely to `../node/doctor-summary.js` — the single shared source
 * of truth also used by `commands/node.ts`'s `doctorCmd()` and the compact
 * doctor overlay in `tui/NodeDashboard.tsx`. This file only maps those
 * classifications to Ink colors/glyphs; it never re-derives health logic.
 *
 * `variant` prop:
 *   - 'screen'  (default) — full, menu-reachable screen. Owns its own
 *     Esc/q → onBack key handling (matches every other full-screen TUI
 *     component in this repo, e.g. BackupScreen/NodeConfig).
 *   - 'overlay' — compact rendering (capability table + summary only, no
 *     step log) intended for embedding inside another screen's own
 *     conditional render. Does NOT bind its own useInput — the host screen
 *     owns all key handling, so it composes cleanly with a parent that's
 *     already intercepting keys for its own popup state (e.g. how
 *     NodeDashboard's `[r]` overlay owns Esc/q/r itself). NodeDashboard
 *     currently calls the underlying `runNodeDoctorSweep()` sweep function
 *     directly rather than mounting this component (see its own doc comment)
 *     to keep a single input-handling owner, but the variant is kept here so
 *     a future compact reuse of the full rendered report doesn't need a
 *     second implementation.
 *
 * The sweep starts automatically on mount (`autoRun: true`) — matches running
 * `memoriahub node doctor` from the command line, which doesn't prompt first.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';

import { ApiClient } from '../api.js';
import type { CliConfig } from '../config.js';
import {
  apiAccessLevel,
  summarizeCapabilities,
  summarizeJobReadiness,
  summarizeStartupGate,
  WORKER_NODE_SETUP_GUIDE_URL,
  type CapabilityRowSummary,
  type HealthLevel,
} from '../node/doctor-summary.js';
import { BOX_BORDER } from './theme.js';
import {
  DOCTOR_STEP_ORDER,
  DOCTOR_STEP_LABELS,
  useNodeDoctorSweep,
  type DoctorStepKey,
  type DoctorSweepState,
} from './useNodeDoctorSweep.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NodeDoctorProps {
  config: CliConfig;
  /** Pop back to the previous screen/menu. Required for variant 'screen'. */
  onBack: () => void;
  /** See the module header comment. Defaults to 'screen'. */
  variant?: 'screen' | 'overlay';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Health level for a top-checklist step, plus the two non-`HealthLevel`
 *  states the checklist also needs to render: not-yet-reached and
 *  currently-running. */
type StepDisplayLevel = HealthLevel | 'pending' | 'running';

/**
 * Classify a single top-checklist step's health from the current sweep
 * state — "did this step find a problem", not merely "did it finish". Each
 * branch reuses the shared doctor-summary.js classifiers so this file never
 * re-derives health logic that already lives there.
 */
function computeStepLevel(step: DoctorStepKey, state: DoctorSweepState): StepDisplayLevel {
  const running = state.currentStep === step;

  switch (step) {
    case 'apiAccess':
      if (!state.apiAccess) return running ? 'running' : 'pending';
      return apiAccessLevel(state.apiAccess);

    case 'capabilities': {
      if (!state.caps) return running ? 'running' : 'pending';
      const anyMissing = Object.values(state.caps).some((s) => !s.available);
      return anyMissing ? 'error' : 'ok';
    }

    case 'selfTest': {
      if (!state.caps || !state.operationalCaps) return running ? 'running' : 'pending';
      const summary = summarizeCapabilities(state.caps, state.operationalCaps);
      if (summary.issues.some((row) => row.level === 'error')) return 'error';
      if (summary.issues.length > 0) return 'warn';
      return 'ok';
    }

    case 'jobReadiness': {
      if (!state.jobReadiness) return running ? 'running' : 'pending';
      const summary = summarizeJobReadiness(state.jobReadiness);
      return summary.issues.length > 0 ? 'error' : 'ok';
    }

    case 'startupGate': {
      if (!state.startupGate) return running ? 'running' : 'pending';
      return summarizeStartupGate(state.startupGate).level;
    }

    case 'models': {
      if (!state.models) return running ? 'running' : 'pending';
      if (state.models.failed.length > 0) return 'error';
      if (state.models.error) return 'warn';
      return 'ok';
    }

    case 'daemon':
      if (!state.daemon) return running ? 'running' : 'pending';
      return state.daemon.stalePidfile ? 'warn' : 'ok';

    default:
      return 'pending';
  }
}

/** Icon + color for a step-display level, matching the existing glyph set
 *  (✔/⚠/✖/spinner/·) used throughout the doctor screens. */
function stepIconAndColor(level: StepDisplayLevel): { icon: React.ReactNode; color: string | undefined; dim: boolean } {
  switch (level) {
    case 'ok':
      return { icon: '✔', color: 'green', dim: false };
    case 'warn':
      return { icon: '⚠', color: 'yellow', dim: false };
    case 'error':
      return { icon: '✖', color: 'red', dim: false };
    case 'running':
      return { icon: <Spinner type="dots" />, color: 'cyan', dim: false };
    case 'pending':
    default:
      return { icon: '·', color: undefined, dim: true };
  }
}

/** Combined installed/operational capability row, mirroring
 *  printOperationalCapabilityTable in commands/node.ts. Renders only the rows
 *  it's given — callers pass the full row set for an all-issues view, or just
 *  the issue subset when collapsing healthy rows away. */
function CapabilityTable({
  rows,
  detailWidth,
}: {
  rows: CapabilityRowSummary[];
  detailWidth: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold dimColor>{'Capability'.padEnd(14)}</Text>
        <Text bold dimColor>{'Installed'.padEnd(11)}</Text>
        <Text bold dimColor>{'Operational'.padEnd(13)}</Text>
        <Text bold dimColor>Detail</Text>
      </Box>
      {rows.map(({ key, installed, operational, level }) => {
        let opLabel: string;
        let opColor: string | undefined;
        if (!installed.available) {
          opLabel = 'n/a';
          opColor = undefined;
        } else if (level === 'ok') {
          opLabel = 'yes';
          opColor = 'green';
        } else {
          opLabel = 'not yet';
          opColor = 'yellow';
        }
        return (
          <Box key={key} flexDirection="row">
            <Text>{key.padEnd(14)}</Text>
            <Text color={installed.available ? 'green' : 'red'}>
              {(installed.available ? 'yes' : 'no').padEnd(11)}
            </Text>
            <Text color={opColor} dimColor={opColor === undefined}>
              {opLabel.padEnd(13)}
            </Text>
            <Text dimColor>{truncate(operational.detail ?? installed.detail ?? '', detailWidth)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeDoctor({ config, onBack, variant = 'screen' }: NodeDoctorProps): React.ReactElement {
  const api = React.useMemo(() => new ApiClient(config), [config]);
  const { state } = useNodeDoctorSweep(api, config, { autoRun: true });

  // Always call the hook (Rules of Hooks) — only act on it in 'screen'
  // variant. 'overlay' relies entirely on the host screen's own key handling.
  useInput((input, key) => {
    if (variant !== 'screen') return;
    if (key.escape || input === 'q') onBack();
  });

  const compact = variant === 'overlay';

  const apiLevel = state.apiAccess ? apiAccessLevel(state.apiAccess) : null;
  const capsSummary =
    state.caps && state.operationalCaps ? summarizeCapabilities(state.caps, state.operationalCaps) : null;
  const jobsSummary = state.jobReadiness ? summarizeJobReadiness(state.jobReadiness) : null;
  const gateSummary = state.startupGate ? summarizeStartupGate(state.startupGate) : null;

  return (
    <Box
      borderStyle={BOX_BORDER}
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={compact ? 0 : 1}
    >
      <Text bold color="cyan">Worker Node — Doctor</Text>

      {/* Step-by-step running log — full screen only. */}
      {!compact && (
        <Box flexDirection="column" marginTop={1}>
          {DOCTOR_STEP_ORDER.map((step) => {
            const level = computeStepLevel(step, state);
            const { icon, color, dim } = stepIconAndColor(level);
            return (
              <Box key={step} flexDirection="row" gap={1}>
                <Text color={color} dimColor={dim}>{icon}</Text>
                <Text color={color} dimColor={dim}>
                  {DOCTOR_STEP_LABELS[step]}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* API Access detail — full screen only, once available. Collapses to
          a single line when fully healthy; expands to the full three-line
          breakdown otherwise so the actual problem stays visible. */}
      {!compact && state.apiAccess && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">API Access</Text>
          {apiLevel === 'ok' ? (
            <Text color="green">✔ API access ok — {truncate(state.apiAccess.authDetail, 84)}</Text>
          ) : (
            <>
              <Text color={state.apiAccess.authOk ? 'green' : 'red'}>
                {state.apiAccess.authOk ? '✔' : '✖'} {truncate(state.apiAccess.authDetail, 84)}
              </Text>
              {state.apiAccess.nodeRegistrationOk !== null ? (
                <Text color={state.apiAccess.nodeRegistrationOk ? 'green' : 'yellow'}>
                  {state.apiAccess.nodeRegistrationOk ? '✔' : '⚠'}{' '}
                  {truncate(state.apiAccess.nodeRegistrationDetail, 84)}
                </Text>
              ) : (
                <Text dimColor>· {truncate(state.apiAccess.nodeRegistrationDetail, 84)}</Text>
              )}
              <Text color={state.apiAccess.manifestOk ? 'green' : 'yellow'}>
                {state.apiAccess.manifestOk ? '✔' : '⚠'} {truncate(state.apiAccess.manifestDetail, 84)}
              </Text>
            </>
          )}
        </Box>
      )}

      {/* Capability table — both variants, once available. Collapses to a
          single line when every capability is operational; otherwise shows a
          one-line count summary followed by only the rows needing attention. */}
      {capsSummary && (
        <Box flexDirection="column" marginTop={1}>
          {!compact && <Text bold color="cyan">Capabilities</Text>}
          {capsSummary.issues.length === 0 ? (
            <Text color="green">✔ All {capsSummary.totalCount} capabilities operational.</Text>
          ) : (
            <>
              <Text dimColor>
                {`${capsSummary.okCount}/${capsSummary.totalCount} capabilities operational — showing ${capsSummary.issues.length} needing attention:`}
              </Text>
              <CapabilityTable rows={capsSummary.issues} detailWidth={compact ? 40 : 60} />
            </>
          )}
        </Box>
      )}

      {/* Job-type readiness — collapses to a single line when every
          configured/eligible type is ready; otherwise a one-line count
          followed by only the not-ready rows. */}
      {state.jobReadiness && (
        <Box flexDirection="column" marginTop={1}>
          {!compact && <Text bold color="cyan">Job-type readiness</Text>}
          {state.jobReadiness.length === 0 ? (
            <Text color="yellow">⚠ No eligible job types configured/supported on this machine.</Text>
          ) : jobsSummary && jobsSummary.issues.length === 0 ? (
            <Text color="green">✔ All {jobsSummary.totalCount} job type(s) ready.</Text>
          ) : (
            <>
              <Text dimColor>{`${jobsSummary?.readyCount ?? 0}/${jobsSummary?.totalCount ?? 0} ready`}</Text>
              {jobsSummary?.issues.map((row) => (
                <Text key={row.type} color="red">
                  ✖ {row.type}
                  <Text dimColor> — missing {row.missing.join(', ')}</Text>
                </Text>
              ))}
            </>
          )}
        </Box>
      )}

      {/* Startup gate — the same fail-fast verdict `node start` uses to decide
          whether a headless container may boot. Collapses to one green line on
          PASS; a blocked gate lists each required capability that failed, and
          any optional/degradable failures render as non-blocking warnings.
          Renders in both variants, mirroring the Capabilities/Job-readiness
          sections. */}
      {gateSummary && (
        <Box flexDirection="column" marginTop={1}>
          {!compact && <Text bold color="cyan">Startup gate</Text>}
          {gateSummary.ok ? (
            <Text color="green">✔ Startup gate: PASS — all required capabilities operational.</Text>
          ) : (
            <>
              <Text color="red">✖ Startup gate: BLOCKED — a required capability is not operational:</Text>
              {gateSummary.blockers.map((b, i) => (
                <Text key={`gate-block-${i}`} color="red">
                  {'  ✖ '}
                  {truncate(b, compact ? 40 : 84)}
                </Text>
              ))}
            </>
          )}
          {gateSummary.degrades.map((d, i) => (
            <Text key={`gate-degrade-${i}`} color="yellow">
              {'  ⚠ '}
              {truncate(d, compact ? 40 : 84)}
            </Text>
          ))}
        </Box>
      )}

      {/* Models — full screen only. */}
      {!compact && state.models && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">Models</Text>
          {state.models.error ? (
            <Text color="yellow">⚠ Could not verify models: {truncate(state.models.error, 84)}</Text>
          ) : state.models.manifestCount === 0 ? (
            <Text dimColor>Server manifest lists no model files.</Text>
          ) : state.models.failed.length > 0 ? (
            <Box flexDirection="column">
              {state.models.failed.map((f) => (
                <Text key={f.name} color="red">✖ Model {f.name}: {truncate(f.error, 76)}</Text>
              ))}
            </Box>
          ) : (
            <Text color="green">
              ✔ All {state.models.manifestCount} model file(s) present/downloaded
              {state.models.targetDir ? ` in ${state.models.targetDir}` : ''}.
            </Text>
          )}
        </Box>
      )}

      {/* Daemon — full screen only, informational. */}
      {!compact && state.daemon && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">Daemon</Text>
          <Text color={state.daemon.running ? 'green' : state.daemon.stalePidfile ? 'yellow' : undefined} dimColor={!state.daemon.running && !state.daemon.stalePidfile}>
            {state.daemon.running ? '✔' : state.daemon.stalePidfile ? '⚠' : '·'} {truncate(state.daemon.detail, 90)}
          </Text>
        </Box>
      )}

      {/* Final summary + setup guide reference — shown every run. */}
      {state.done && (
        <Box marginTop={1} flexDirection="column">
          {state.hasError ? (
            <Text color="red" bold>✖ Doctor found problems — this node cannot fully process its eligible types.</Text>
          ) : (
            <Text color="green" bold>✔ Doctor: all checks passed.</Text>
          )}
          <Text dimColor>Setup guide: {WORKER_NODE_SETUP_GUIDE_URL}</Text>
        </Box>
      )}

      {!compact && (
        <Box marginTop={1}>
          <Text dimColor>[Esc/q] back</Text>
        </Box>
      )}
    </Box>
  );
}
