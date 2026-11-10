import type { MemoriahubSettingsPort } from '../ports/index.js';

/**
 * Whether a feature is on: its `features.<flag>` system setting is `true` AND its environment kill
 * switch (when the feature has one) is not the string `false`. Reads through the settings port, which
 * caches for a few seconds, so a bulk import checks it per file without a query per file.
 *
 * @param settings - the settings port.
 * @param flag - the flag name under the `features` namespace (`pictureEnhancement`).
 * @param killSwitchEnv - the environment variable that forces the feature off when it is `false`.
 * @returns true when the feature is on.
 * @stability experimental
 */
export async function isFeatureEnabled(
  settings: MemoriahubSettingsPort,
  flag: string,
  killSwitchEnv?: string,
): Promise<boolean> {
  if (killSwitchEnv !== undefined && process.env[killSwitchEnv] === 'false') return false;
  const { value } = await settings.readSystem<Record<string, unknown>>('features');
  return value?.[flag] === true;
}

/**
 * Why a feature's upload-time job is NOT wanted, or `null` when it is: the `features.<flag>` system
 * setting must be on and the kill switch must not be `false`. The gate every slice registers with the
 * media slice's upload fan-out.
 *
 * @param settings - the settings port.
 * @param flag - the flag under the `features` namespace.
 * @param killSwitchEnv - the environment variable that forces the feature off when it is `false`.
 * @returns `null` to enqueue, else `feature disabled` or `<ENV>=false`.
 * @stability experimental
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
