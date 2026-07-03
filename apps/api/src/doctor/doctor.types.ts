// =============================================================================
// Doctor Diagnostics — Types
// =============================================================================
//
// Report contract for the admin "Doctor" configuration health sweep.
// Pure on-demand computation — no DB persistence, no cron.
// =============================================================================

export type DoctorCheckStatus = 'ok' | 'warning' | 'error' | 'skipped';

export interface DoctorCheck {
  key: string;
  label: string;
  status: DoctorCheckStatus;
  message: string;
  actionItem?: string;
  durationMs: number;
}

export interface DoctorSection {
  key: string;
  label: string;
  /** Worst status among its checks; 'skipped' counts as 'ok' for aggregation. */
  status: DoctorCheckStatus;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  computedAt: string;
  durationMs: number;
  summary: { ok: number; warning: number; error: number; skipped: number; total: number };
  sections: DoctorSection[];
}
