/**
 * Admin → Settings → Doctor (`/admin/settings/doctor`).
 *
 * The platform's page (RETRO-B1b, #602): the report of `GET /api/admin/doctor`
 * with "Run again" and the redacted support-bundle download. This file is only
 * the lazy-loaded binding: this app's category order and labels. The registry
 * card is in `config/adminSections.tsx` and the route, gated on the
 * `system_settings:read` the API enforces, is in `App.tsx`.
 */
import { DoctorPage as PackagedDoctorPage } from '@marinoscar/platform-web/doctor/ui';
import { DOCTOR_CATEGORIES } from '../../config/doctorCategories';

export default function DoctorPage() {
  return <PackagedDoctorPage categories={DOCTOR_CATEGORIES} />;
}
