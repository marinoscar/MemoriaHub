// =============================================================================
// MEMORIAHUB_METRICS: the metrics port (RETRO-J4, #610)
// =============================================================================
//
// Counters and histograms by REGISTERED metric name (the host declares the name,
// unit and label vocabulary: enrichment throughput, upload rate, face / tag /
// memory generation). Optional: an unbound port is a no-op
// (`NOOP_MEMORIAHUB_METRICS` of `@marinoscar/memoriahub-api/core`).
//
// LABELS ARE ENUMS. Never an organization, user, group, media, node or job id, a
// file name or an error text: the host drops an undeclared attribute and turns a
// value outside its enum into `other`. Neither call awaits or throws.
// =============================================================================

/**
 * Injection token of {@link MemoriahubMetricsPort}. The description string is
 * permanent. Optional in `MemoriahubPortsModule.forRoot`: the default does nothing.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_METRICS = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_METRICS');

/**
 * The metrics port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubMetricsPort {
  /**
   * Adds to a counter.
   *
   * @param key - a registered metric key (`mediaUploads`).
   * @param value - the amount; 1 when absent.
   * @param attributes - enum-valued labels.
   */
  add(key: string, value?: number, attributes?: Record<string, unknown>): void;

  /**
   * Records one observation of a histogram.
   *
   * @param key - a registered metric key (`mediaUploadSize`).
   * @param value - the observation.
   * @param attributes - enum-valued labels.
   */
  record(key: string, value: number, attributes?: Record<string, unknown>): void;
}
