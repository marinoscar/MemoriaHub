/**
 * tui/JobsDashboard.tsx — Ink-based live job queue dashboard.
 *
 * Stub for checkpoint 2 — full implementation in checkpoint 3.
 */

import type { ApiClient } from '../api.js';

export interface JobsDashboardProps {
  api: ApiClient;
  intervalMs: number;
  windowDays: number;
}

export async function renderJobsDashboard(_props: JobsDashboardProps): Promise<void> {
  // Implementation in full checkpoint 3
}
