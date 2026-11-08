import { api } from './api';

// =============================================================================
// Email readiness (RETRO-D2, #570)
// =============================================================================
//
// The email settings page is the platform's (`@marinoscar/platform-web/email/ui`,
// with its own hook and client). The one thing the app still reads itself is
// whether outbound email is usable, for the Memories settings page's digest
// warning: the `provider` and `enabled` fields of `GET /api/email-settings`
// (the platform route, `system_settings:read`).
// =============================================================================

/** The two fields of the platform email settings response the app reads. */
export interface EmailReadiness {
  /** The selected transport id (`ses`, `smtp`, or an app-registered one), or null. */
  provider: string | null;
  /** Master switch: nothing is sent while false. */
  enabled: boolean;
}

export async function getEmailSettings(): Promise<EmailReadiness> {
  return api.get<EmailReadiness>('/email-settings');
}
