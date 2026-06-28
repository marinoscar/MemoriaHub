/**
 * preflight.ts — PAT validation and expiry checks run before a sync or retry.
 *
 * Calling runPatPreflight() before starting a long import gives users an
 * actionable error BEFORE hours of work rather than a cryptic mid-run failure.
 *
 *  • 401 from GET /api/auth/me  → exit(1) with a clear "run login" message.
 *  • Token expires within 7 days → warn so the user can refresh proactively.
 *  • Network / 5xx errors        → warn but proceed (don't block syncs for
 *    transient connectivity issues).
 */

import { ApiClient, ApiError } from './api.js';
import type { CliConfig } from './config.js';
import { ui } from './ui.js';

/** Warn when the PAT expires within this many days. */
const PAT_WARN_DAYS = 7;

/**
 * Run PAT pre-flight checks before a sync or retry command.
 *
 * Exits the process (code 1) if the token is invalid or expired (HTTP 401).
 * Prints a warning and continues if the token expires soon or the server is
 * temporarily unreachable.
 */
export async function runPatPreflight(
  api: ApiClient,
  config: CliConfig,
): Promise<void> {
  // -----------------------------------------------------------------
  // 1. Validate that the token is currently accepted by the server.
  // -----------------------------------------------------------------
  try {
    await api.get<{ email: string }>('/api/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      ui.error(
        'Your access token is invalid or expired. ' +
        'Run `memoriahub login` to re-authenticate, then re-run this command.',
      );
      process.exit(1);
    }

    // Non-401 failure (network outage, 5xx, etc.): warn but let the sync
    // proceed so a momentary server hiccup doesn't abort a queued import.
    const msg = err instanceof Error ? err.message : String(err);
    ui.warn(
      `Pre-flight check could not reach the server: ${msg}. Proceeding anyway.`,
    );
    return;
  }

  // -----------------------------------------------------------------
  // 2. Warn when the token is close to expiry.
  // -----------------------------------------------------------------
  if (config.patExpiresAt) {
    const expiresMs = new Date(config.patExpiresAt).getTime();
    if (!Number.isNaN(expiresMs)) {
      const daysLeft = Math.ceil(
        (expiresMs - Date.now()) / (1000 * 60 * 60 * 24),
      );
      // Only warn in the window [1, PAT_WARN_DAYS].  If already expired, the
      // 401 check above would have caught it before we reach this branch.
      if (daysLeft > 0 && daysLeft <= PAT_WARN_DAYS) {
        ui.warn(
          `Your access token expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — ` +
          `run 'memoriahub login' to refresh before large imports.`,
        );
      }
    }
  }
}
