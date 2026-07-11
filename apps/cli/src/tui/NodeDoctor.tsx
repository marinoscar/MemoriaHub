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
import type { CapabilityStatus } from '../node/capabilities.js';
import { BOX_BORDER } from './theme.js';
import {
  DOCTOR_STEP_ORDER,
  DOCTOR_STEP_LABELS,
  useNodeDoctorSweep,
  type DoctorStepKey,
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

/** Combined installed/operational capability row, mirroring
 *  printOperationalCapabilityTable in commands/node.ts. */
function CapabilityTable({
  caps,
  operational,
  detailWidth,
}: {
  caps: Record<string, CapabilityStatus>;
  operational: Record<string, CapabilityStatus>;
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
      {Object.entries(caps).map(([key, status]) => {
        const op = operational[key] ?? status;
        let opLabel: string;
        let opColor: string | undefined;
        if (!status.available) {
          opLabel = 'n/a';
          opColor = undefined;
        } else if (op.available) {
          opLabel = 'yes';
          opColor = 'green';
        } else {
          opLabel = 'not yet';
          opColor = 'yellow';
        }
        return (
          <Box key={key} flexDirection="row">
            <Text>{key.padEnd(14)}</Text>
            <Text color={status.available ? 'green' : 'red'}>
              {(status.available ? 'yes' : 'no').padEnd(11)}
            </Text>
            <Text color={opColor} dimColor={opColor === undefined}>
              {opLabel.padEnd(13)}
            </Text>
            <Text dimColor>{truncate(op.detail ?? status.detail ?? '', detailWidth)}</Text>
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
  const stepDone = (step: DoctorStepKey): boolean => state.completedSteps.includes(step);

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
            const done = stepDone(step);
            const active = state.currentStep === step;
            return (
              <Box key={step} flexDirection="row" gap={1}>
                <Text color={done ? 'green' : active ? 'cyan' : undefined} dimColor={!done && !active}>
                  {done ? '✔' : active ? <Spinner type="dots" /> : '·'}
                </Text>
                <Text color={active ? 'cyan' : undefined} dimColor={!done && !active}>
                  {DOCTOR_STEP_LABELS[step]}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* API Access detail — full screen only, once available. */}
      {!compact && state.apiAccess && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">API Access</Text>
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
        </Box>
      )}

      {/* Capability table — both variants, once available. */}
      {state.caps && state.operationalCaps && (
        <Box flexDirection="column" marginTop={1}>
          {!compact && <Text bold color="cyan">Capabilities</Text>}
          <CapabilityTable caps={state.caps} operational={state.operationalCaps} detailWidth={compact ? 40 : 60} />
        </Box>
      )}

      {/* Job-type readiness. */}
      {state.jobReadiness && (
        <Box flexDirection="column" marginTop={1}>
          {!compact && <Text bold color="cyan">Job-type readiness</Text>}
          {state.jobReadiness.length === 0 && (
            <Text color="yellow">⚠ No eligible job types configured/supported on this machine.</Text>
          )}
          {state.jobReadiness.map((row) => (
            <Text key={row.type} color={row.ready ? 'green' : 'red'}>
              {row.ready ? '✔' : '✖'} {row.type}
              {!row.ready && <Text dimColor> — missing {row.missing.join(', ')}</Text>}
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

      {/* Final summary. */}
      {state.done && (
        <Box marginTop={1}>
          {state.hasError ? (
            <Text color="red" bold>✖ Doctor found problems — this node cannot fully process its eligible types.</Text>
          ) : (
            <Text color="green" bold>✔ Doctor: all checks passed.</Text>
          )}
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
