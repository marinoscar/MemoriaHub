// =============================================================================
// The expiring-share notification event and the sweep job type (epic #240, RETRO-C9, RETRO-J10)
// =============================================================================
//
// THE EVENT KEY AND THE JOB TYPE ARE PERMANENT: an inbox row, a user preference and a queued job name
// them. Add one; never rename or reuse.
// =============================================================================

/**
 * The event raised once per public link and expiry date. Persisted on every row. The host declares the
 * event (title, link, one row per occurrence).
 *
 * @stability experimental
 */
export const SHARE_EXPIRING_EVENT_KEY = 'shares.expiring';

/**
 * The permanent job type of the daily expiring-share sweep (server-only, a system job).
 *
 * @stability experimental
 */
export const SHARE_EXPIRING_SWEEP_TYPE = 'shares.expiring_sweep';
