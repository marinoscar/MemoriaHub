import type { DoctorCategoryLabel } from '@marinoscar/platform-web/doctor/headless';
import { PLATFORM_DOCTOR_CATEGORY_LABELS } from '@marinoscar/platform-web/doctor/headless';

/**
 * The Doctor's categories, in the order the API reports them
 * (`DOCTOR_CATEGORY_ORDER` in `apps/api/src/doctor/doctor.config.ts`): the
 * platform's categories plus this app's own, `face`, `geo`, `workflows` and
 * `android`. The two lists change together (RETRO-B1b, #602).
 */
const APP_LABELS: Record<string, string> = {
  face: 'Face recognition',
  geo: 'Geo',
  workflows: 'Workflows',
  android: 'Android app',
};

const PLATFORM = new Map(PLATFORM_DOCTOR_CATEGORY_LABELS.map((c) => [c.key, c]));

export const DOCTOR_CATEGORIES: readonly DoctorCategoryLabel[] = [
  'core',
  'auth',
  'maintenance',
  'storage',
  'email',
  'push',
  'ai',
  'face',
  'geo',
  'jobs',
  'nodes',
  'workflows',
  'android',
  'backup',
  'telemetry',
  'network',
].map((key) => PLATFORM.get(key) ?? { key, label: APP_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1) });
