import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  status: DoctorCheckStatus;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  computedAt: string;
  durationMs: number;
  summary: {
    ok: number;
    warning: number;
    error: number;
    skipped: number;
    total: number;
  };
  sections: DoctorSection[];
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function runDoctor(): Promise<DoctorReport> {
  return api.post<DoctorReport>('/admin/doctor/run', {});
}
