// =============================================================================
// FACE_CONFIG: the slice's read-only view of the deployment configuration
// =============================================================================
//
// The face thresholds, the vector backend and the candidate counts are deployment
// configuration (`FACE_MATCH_THRESHOLD`, `FACE_CLUSTER_THRESHOLD`, ...). The host
// binds this token to whatever reads its configuration (the web edition binds Nest's
// `ConfigService`); the variable NAMES are the host's contract and never change.
// =============================================================================

/**
 * Injection token of the configuration reader.
 *
 * @stability experimental
 */
export const FACE_CONFIG = Symbol.for('@marinoscar/memoriahub/FACE_CONFIG');

/**
 * What the slice reads of the deployment configuration: structurally a subset of Nest's `ConfigService`.
 *
 * @stability experimental
 */
export interface FaceConfigReader {
  /**
   * Reads one configuration value.
   *
   * @param key - the variable name, such as `FACE_MATCH_THRESHOLD`.
   * @returns its value, or `undefined` when unset.
   */
  get<T = string>(key: string): T | undefined;
}

/**
 * A reader over the process environment: what a bare host binds when it has no configuration service.
 *
 * @stability experimental
 */
export const ENV_FACE_CONFIG: FaceConfigReader = Object.freeze({
  get<T = string>(key: string): T | undefined {
    return process.env[key] as unknown as T | undefined;
  },
});

/**
 * Reads one environment-backed switch the way the kill switches always did: set to anything but `false`
 * means on.
 *
 * @param name - the variable name.
 * @returns `false` only when the variable is the string `false`.
 * @stability experimental
 */
export function envSwitchOn(name: string): boolean {
  return (process.env[name] ?? 'true') !== 'false';
}
