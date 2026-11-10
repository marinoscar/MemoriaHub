import type { MemoriahubSettingsPort } from '@marinoscar/memoriahub-api/ports';

// =============================================================================
// Gates of the upload enrichment fan-out (RETRO-J5, #613)
// =============================================================================
//
// Each slice registers its own fan-out with the media slice's
// `UploadEnrichmentRegistry` (see `tagging/tagging-upload-enrichment.ts`, ...).
// The gate is always the same pair: the `features.<flag>` system setting AND the
// feature's environment kill switch. A slice that moves into its own package
// takes its registration with it.
// =============================================================================

/**
 * Why a feature's upload job is NOT wanted, or `null` when it is: the
 * `features.<flag>` setting must be on and the kill switch must not be `false`.
 *
 * @param settings - the settings port (cached by the host).
 * @param flag - the flag under the `features` namespace.
 * @param killSwitchEnv - the environment variable that forces the feature off when it is `false`.
 * @returns `null` to enqueue, else `feature disabled` or `<ENV>=false`.
 */
export async function featureSkipReason(
  settings: MemoriahubSettingsPort,
  flag: string,
  killSwitchEnv: string,
): Promise<string | null> {
  const { value } = await settings.readSystem<Record<string, unknown>>('features');
  const on = value?.[flag] === true;
  const killed = process.env[killSwitchEnv] === 'false';
  if (on && !killed) return null;
  return !on ? 'feature disabled' : `${killSwitchEnv}=false`;
}
