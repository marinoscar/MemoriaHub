// =============================================================================
// The telemetry assistant's AI port: DISABLED (RETRO-T2, #625)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(RETRO-E1/E4): the telemetry assistant spends the calling
// user's key through the platform AI slice (`AiService.forUser(userId, { feature:
// 'telemetry.assistant' })`). MemoriaHub's AI call sites, keys and model
// catalogue are not on that slice yet (RETRO-E2 moves the call sites, E3 the
// keys, E4 the admin pages and the web adapters), so the assistant stays off:
//
//   * `assertEnabled()` throws the platform's 403 `AI_DISABLED`, the same error
//     the AI kill switch answers, so `TelemetryAiEnabledGuard` refuses
//     `POST /api/admin/telemetry/assistant/stream` with a normal "AI is off"
//     response, never a 500;
//   * `forUser()` is unreachable behind that guard; it throws the same error in
//     case a future caller skips the guard;
//   * `defineTool()` and `isAiError()` are pure and answer as the real adapter
//     does.
//
// The web half of the same shim is `apps/web/src/platform/telemetryAdapters.ts`
// (AI reported off, no models), so the panel shows "AI disabled", not an error.
// Swapped for the kvox-style adapter over `AiService` / `AiConfigService` once
// RETRO-E4 lands (docs/platform-adoption/local-exceptions.md).
// =============================================================================

import { Injectable } from '@nestjs/common';
import { AiError } from '@marinoscar/platform-api/ai';
import type {
  TelemetryAiError,
  TelemetryAiPort,
  TelemetryAiSession,
  TelemetryAiTool,
  TelemetryAiToolDefinition,
} from '@marinoscar/platform-api/telemetry';
import type { z } from 'zod';

/** The message the assistant shows while it is off in this deployment. */
export const TELEMETRY_ASSISTANT_DISABLED_MESSAGE =
  'The telemetry assistant is not available in this deployment yet.';

function aiDisabled(): AiError {
  return new AiError('AI_DISABLED', TELEMETRY_ASSISTANT_DISABLED_MESSAGE, { details: { scope: 'system' } });
}

@Injectable()
export class TelemetryAiDisabledAdapter implements TelemetryAiPort {
  forUser(_userId: string): TelemetryAiSession {
    throw aiDisabled();
  }

  defineTool<P extends z.ZodType, R>(definition: TelemetryAiToolDefinition<P, R>): TelemetryAiTool {
    // Opaque to telemetry; never run while the assistant is off.
    return Object.freeze({ name: definition.name }) as unknown as TelemetryAiTool;
  }

  isAiError(error: unknown): error is TelemetryAiError {
    return error instanceof AiError;
  }

  /** Always refuses: 403 `AI_DISABLED`. */
  async assertEnabled(): Promise<void> {
    throw aiDisabled();
  }
}
