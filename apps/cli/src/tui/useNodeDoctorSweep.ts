/**
 * tui/useNodeDoctorSweep.ts — shared operational doctor sweep for the TUI.
 *
 * `memoriahub node doctor` (commands/node.ts's `doctorCmd()`) runs SIX health
 * checks in sequence: API access, installed-capability presence, real
 * operational self-tests, job-type readiness (gated on the operational
 * result), model presence/download, and daemon liveness. Two TUI surfaces
 * need that exact same sweep:
 *
 *   - tui/NodeDoctor.tsx        — full screen, menu-reachable
 *   - tui/NodeDashboard.tsx     — the `[r]` doctor overlay (compact, in-context)
 *
 * This module is the single source of truth for the sweep so neither surface
 * re-implements (or drifts from) `doctorCmd()`'s logic. It exports:
 *
 *   - `runNodeDoctorSweep(api, cfg, onProgress?)` — a plain async function
 *     with NO React/Ink dependency. Directly unit-testable and directly
 *     invokable headlessly (e.g. from a throwaway script) against a real
 *     machine. Reports incremental progress via `onProgress`, called after
 *     every step transition (entering AND finishing a step) so a caller can
 *     render a live step-by-step log.
 *   - `useNodeDoctorSweep(api, cfg, options?)` — a thin Ink/React hook that
 *     wraps the function above: `{ state, running, run }`. `run()` (re)starts
 *     the sweep; `options.autoRun` (default false) starts it once on mount.
 *
 * Never throws. Every step is individually wrapped in try/catch (mirroring
 * self-test.ts's per-capability isolation) — a broken capability, a thrown
 * exception from an API-access check, an unreachable model manifest, etc.
 * never prevents the rest of the sweep from completing and never crashes the
 * TUI process. Unlike the CLI command, this module never calls
 * `process.exit()` — the "did everything pass" verdict is surfaced only as
 * `state.hasError` for the caller to render.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiClient } from '../api.js';
import type { CliConfig } from '../config.js';
import {
  detectCapabilities,
  missingRequirements,
  NODE_JOB_TYPES,
  isNodeJobType,
  type CapabilityStatus,
  type NodeJobType,
} from '../node/capabilities.js';
import { ensureModels } from '../node/models.js';
import { runOperationalSelfTests } from '../node/self-test.js';
import {
  runApiAccessChecks,
  checkDaemonLiveness,
  type ApiAccessCheckResult,
  type DaemonLivenessResult,
} from '../node/doctor-checks.js';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DoctorStepKey =
  | 'apiAccess'
  | 'capabilities'
  | 'selfTest'
  | 'jobReadiness'
  | 'models'
  | 'daemon';

/** Sweep step order — mirrors doctorCmd()'s six sections, in order. */
export const DOCTOR_STEP_ORDER: DoctorStepKey[] = [
  'apiAccess',
  'capabilities',
  'selfTest',
  'jobReadiness',
  'models',
  'daemon',
];

export const DOCTOR_STEP_LABELS: Record<DoctorStepKey, string> = {
  apiAccess: 'API Access',
  capabilities: 'Capabilities (installed)',
  selfTest: 'Operational self-tests',
  jobReadiness: 'Job-type readiness',
  models: 'Models',
  daemon: 'Daemon',
};

export interface JobReadinessRow {
  type: NodeJobType;
  ready: boolean;
  missing: string[];
}

export interface ModelsSweepResult {
  /** Number of files listed in the server manifest. */
  manifestCount: number;
  downloaded: string[];
  present: string[];
  failed: Array<{ name: string; error: string }>;
  targetDir: string | null;
  /** Set only when the manifest fetch itself failed (never affects hasError). */
  error: string | null;
}

export interface DoctorSweepState {
  /** Step currently running, or null before start / once the sweep is done. */
  currentStep: DoctorStepKey | null;
  /** Steps that have finished (success or failure), in completion order. */
  completedSteps: DoctorStepKey[];
  apiAccess: ApiAccessCheckResult | null;
  /** Presence-only probe — `detectCapabilities()`. */
  caps: Record<string, CapabilityStatus> | null;
  /** Real self-test result — `runOperationalSelfTests()`. */
  operationalCaps: Record<string, CapabilityStatus> | null;
  jobReadiness: JobReadinessRow[] | null;
  models: ModelsSweepResult | null;
  daemon: DaemonLivenessResult | null;
  /** True once every step has finished (success or failure). */
  done: boolean;
  /**
   * Aggregate pass/fail, mirroring doctorCmd()'s `hasError` flag: true when
   * auth failed, a configured/supported job type is missing a required
   * operational capability, or a model file failed to download/verify.
   * Daemon liveness and node-registration/manifest reachability are
   * informational only and never set this.
   */
  hasError: boolean;
}

export function initialDoctorSweepState(): DoctorSweepState {
  return {
    currentStep: null,
    completedSteps: [],
    apiAccess: null,
    caps: null,
    operationalCaps: null,
    jobReadiness: null,
    models: null,
    daemon: null,
    done: false,
    hasError: false,
  };
}

/** The slice of CliConfig the sweep actually needs — keeps the function easy
 *  to call headlessly without constructing a full CliConfig. */
export type DoctorSweepConfig = Pick<CliConfig, 'nodeId' | 'node'>;

// ---------------------------------------------------------------------------
// Plain async sweep function (no React/Ink dependency)
// ---------------------------------------------------------------------------

/**
 * Run the full six-step doctor sweep once, reporting incremental progress.
 * Resolves with the final state; never rejects.
 */
export async function runNodeDoctorSweep(
  api: ApiClient,
  cfg: DoctorSweepConfig,
  onProgress?: (state: DoctorSweepState) => void,
): Promise<DoctorSweepState> {
  let state = initialDoctorSweepState();
  let hasError = false;
  const emit = (): void => onProgress?.(state);

  const enterStep = (step: DoctorStepKey): void => {
    state = { ...state, currentStep: step };
    emit();
  };
  const leaveStep = (step: DoctorStepKey, patch: Partial<DoctorSweepState>): void => {
    state = {
      ...state,
      ...patch,
      currentStep: null,
      completedSteps: [...state.completedSteps, step],
      hasError,
    };
    emit();
  };

  // 1. API Access — auth roundtrip, node-registration validity, model-manifest
  //    reachability. Only an auth failure counts toward hasError (mirrors
  //    doctorCmd(): registration/manifest problems are warnings only).
  enterStep('apiAccess');
  let access: ApiAccessCheckResult;
  try {
    access = await runApiAccessChecks(api, cfg.nodeId);
  } catch (err) {
    access = {
      authOk: false,
      authDetail: `API access check threw: ${errMsg(err)}`,
      nodeRegistrationOk: null,
      nodeRegistrationDetail: 'not checked — API access check failed',
      manifestOk: false,
      manifestDetail: 'not checked — API access check failed',
    };
  }
  if (!access.authOk) hasError = true;
  leaveStep('apiAccess', { apiAccess: access });

  // 2. Capabilities (installed) — presence probe only, no side effects.
  enterStep('capabilities');
  let caps: Record<string, CapabilityStatus>;
  try {
    caps = await detectCapabilities();
  } catch (err) {
    caps = { _error: { available: false, detail: `capability detection failed: ${errMsg(err)}` } };
  }
  leaveStep('capabilities', { caps });

  // 3. Operational self-tests — a real decode/embed/detect/OCR-init pass for
  //    every capability reported present above.
  enterStep('selfTest');
  let operationalCaps: Record<string, CapabilityStatus>;
  try {
    operationalCaps = await runOperationalSelfTests(caps);
  } catch (err) {
    // runOperationalSelfTests already isolates every individual self-test;
    // this catch only guards against something unexpected in its own control
    // flow so the sweep can never crash the caller.
    operationalCaps = caps;
    state = {
      ...state,
      caps: {
        ...caps,
        _selfTestError: { available: false, detail: `operational self-tests failed: ${errMsg(err)}` },
      },
    };
  }
  leaveStep('selfTest', { operationalCaps });

  // 4. Job-type readiness — gated on the OPERATIONAL result, not mere
  //    presence, so a node whose sharp binary resolves but crashes on first
  //    use (or whose models aren't downloaded yet) is correctly not-ready.
  enterStep('jobReadiness');
  const configuredTypes = (cfg.node?.eligibleTypes ?? []).filter(isNodeJobType);
  const eligibleTypes: NodeJobType[] =
    configuredTypes.length > 0
      ? configuredTypes
      : NODE_JOB_TYPES.filter((t) => missingRequirements(t, operationalCaps).length === 0);
  const jobReadiness: JobReadinessRow[] = eligibleTypes.map((t) => {
    const missing = missingRequirements(t, operationalCaps);
    if (missing.length > 0) hasError = true;
    return { type: t, ready: missing.length === 0, missing };
  });
  leaveStep('jobReadiness', { jobReadiness });

  // 5. Models — download-and-verify, as `node start` does.
  enterStep('models');
  let models: ModelsSweepResult;
  try {
    const manifest = await api.getModelManifest();
    if (manifest.length === 0) {
      models = { manifestCount: 0, downloaded: [], present: [], failed: [], targetDir: null, error: null };
    } else {
      const res = await ensureModels(manifest);
      if (res.failed.length > 0) hasError = true;
      models = {
        manifestCount: manifest.length,
        downloaded: res.downloaded,
        present: res.present,
        failed: res.failed,
        targetDir: res.targetDir,
        error: null,
      };
    }
  } catch (err) {
    // Manifest unreachable: warning only, never affects hasError (mirrors
    // doctorCmd()'s `ui.warn` branch here).
    models = { manifestCount: 0, downloaded: [], present: [], failed: [], targetDir: null, error: errMsg(err) };
  }
  leaveStep('models', { models });

  // 6. Daemon liveness — informational only, never affects hasError.
  enterStep('daemon');
  let daemon: DaemonLivenessResult;
  try {
    daemon = await checkDaemonLiveness();
  } catch (err) {
    daemon = {
      running: false,
      stalePidfile: false,
      pidInfo: null,
      snapshot: null,
      detail: `daemon liveness check failed: ${errMsg(err)}`,
    };
  }
  leaveStep('daemon', { daemon });

  state = { ...state, done: true, hasError };
  emit();
  return state;
}

// ---------------------------------------------------------------------------
// React hook wrapper
// ---------------------------------------------------------------------------

export interface UseNodeDoctorSweepOptions {
  /** Start the sweep once automatically when the hook first mounts. */
  autoRun?: boolean;
}

export interface UseNodeDoctorSweepResult {
  state: DoctorSweepState;
  /** True while a sweep is in flight. */
  running: boolean;
  /** (Re)start the sweep. No-op while one is already running. */
  run: () => void;
}

/**
 * Ink/React hook wrapper over {@link runNodeDoctorSweep}. `api`/`cfg` are read
 * fresh on every `run()` call via refs, so callers don't need to memoize them.
 */
export function useNodeDoctorSweep(
  api: ApiClient,
  cfg: DoctorSweepConfig,
  options?: UseNodeDoctorSweepOptions,
): UseNodeDoctorSweepResult {
  const [state, setState] = useState<DoctorSweepState>(initialDoctorSweepState);
  const [running, setRunning] = useState<boolean>(false);
  const runningRef = useRef<boolean>(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const run = useCallback((): void => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setState(initialDoctorSweepState());
    void runNodeDoctorSweep(apiRef.current, cfgRef.current, setState).finally(() => {
      runningRef.current = false;
      setRunning(false);
    });
  }, []);

  useEffect(() => {
    if (options?.autoRun) run();
    // Intentionally run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, running, run };
}
