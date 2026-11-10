// =============================================================================
// Constants of the search slice (RETRO-J7, #618)
// =============================================================================

/**
 * The permission strings the search routes require. They equal the host catalog's: a permission is
 * data the identity port checks, and the host registers the catalog.
 *
 * @stability experimental
 */
export const SEARCH_PERMISSIONS = {
  /** Use deterministic, semantic and agentic search. */
  SEARCH_USE: 'search:use',
} as const;

/**
 * The id of the AI feature the agentic search calls under. A feature id is permanent once usage rows
 * carry it (`ai_usage_events.feature`); the host registers it before the application starts.
 *
 * @stability experimental
 */
export const SEARCH_AI_FEATURE = 'search_agent';
