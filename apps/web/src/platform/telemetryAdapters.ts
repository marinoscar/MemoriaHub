/**
 * What the packaged telemetry pages take from MemoriaHub (RETRO-T2, #625).
 *
 * `@marinoscar/platform-web/telemetry/ui` renders the Telemetry settings page, the
 * Explorer and the Dashboard. A module constant (the pages call the hooks on every
 * render), the same shape as `platform/jobsAdapters.ts`:
 *
 *   - `Spinner`: this app's `LoadingSpinner`.
 *   - `useAiEnabled` / `useAssistantModels`: PLATFORM-ADOPTION-SHIM(RETRO-E4). The
 *     assistant runs on the platform AI slice, which does not carry MemoriaHub's
 *     keys and model catalogue yet, and the API binds its AI port to a disabled
 *     stub (`apps/api/src/platform/telemetry/telemetry-ai.adapter.ts`). So AI reads
 *     as off (not loading) and the picker has no models: the assistant panel shows
 *     "AI disabled", never an error. RETRO-E4 swaps these for hooks over
 *     `@marinoscar/platform-web/ai/headless` (`useAiConfig`, `useAiModels`).
 */

import type {
  TelemetryAiEnabledState,
  TelemetryAssistantModelsState,
  TelemetryWebAdapters,
} from '@marinoscar/platform-web/telemetry/headless';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

const AI_OFF: TelemetryAiEnabledState = { enabled: false, isLoading: false };
const NO_MODELS: TelemetryAssistantModelsState = { models: [], isLoading: false, error: null };

function useAiEnabled(): TelemetryAiEnabledState {
  return AI_OFF;
}

function useAssistantModels(): TelemetryAssistantModelsState {
  return NO_MODELS;
}

export const appTelemetryAdapters: TelemetryWebAdapters = {
  useAiEnabled,
  useAssistantModels,
  Spinner: LoadingSpinner,
};
