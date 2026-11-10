import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  AiError,
  AiService,
  registerAiFeature,
  aiFeatureRegistry,
  type AiRequest,
  type AiStreamEvent,
  type AiSystemClient,
  type AiUserClient,
} from '@marinoscar/platform-api/ai';
import {
  MemoriahubAiError,
  type MemoriahubAiCallOptions,
  type MemoriahubAiClient,
  type MemoriahubAiEmbedResult,
  type MemoriahubAiErrorClass,
  type MemoriahubAiFeatureDef,
  type MemoriahubAiImageEditRequest,
  type MemoriahubAiImageResult,
  type MemoriahubAiInputItem,
  type MemoriahubAiPort,
  type MemoriahubAiRequest,
  type MemoriahubAiResponse,
  type MemoriahubAiScope,
  type MemoriahubAiStreamEvent,
  type MemoriahubAiStructuredResponse,
  type MemoriahubAiTranscribeRequest,
  type MemoriahubAiTranscription,
  type MemoriahubAiUsage,
} from '@marinoscar/memoriahub-api/ports';

// =============================================================================
// PlatformMemoriahubAiAdapter: the `MEMORIAHUB_AI` port over the platform `AiService` (RETRO-J4, #610)
// =============================================================================
//
// `forUser` is `AiService.forUser(userId, { orgId, feature, jobId })` and `forSystem` is
// `AiService.forSystem({ orgId, feature, jobId })`: the user's own key, else the organization's, else the
// deployment's, resolved per call by the platform; this adapter never sees one. The seven features
// MemoriaHub registers (`app-registrations/ai.ts`) stay registered where they are; `registerFeature` here
// only adds one a slice brings.
//
// WHAT THE ADAPTER TRANSLATES
//   * requests: the port's request is the platform's Responses-style one reduced to MemoriaHub's fields. A
//     string message content becomes one text part; a JSON-Schema tool parameter becomes a Zod schema.
//   * streams: the platform's events (`output_text.delta`, `output_item.done` with a `function_call`,
//     `response.completed`, `error`) become `text`, `tool_call` and `done`. A tool call is yielded once (the
//     completed response is the backstop), and an `error` event is thrown.
//   * errors: an `AiError` becomes a `MemoriahubAiError` with a class a slice branches on (`rate_limit`
//     carries the provider's retry hint); a message never holds key material.
// =============================================================================

/** The class a slice sees for each platform error code. */
const ERROR_CLASS: Readonly<Record<string, MemoriahubAiErrorClass>> = {
  AI_DISABLED: 'not_configured',
  AI_PROVIDER_DISABLED: 'not_configured',
  AI_MODEL_NOT_ENABLED: 'not_configured',
  AI_MODEL_NOT_REACHABLE: 'not_configured',
  AI_TOOL_DISABLED: 'not_configured',
  AI_REALTIME_DISABLED: 'not_configured',
  AI_KEY_REQUIRED: 'key_missing',
  AI_KEY_INVALID: 'auth',
  AI_CAPABILITY_UNSUPPORTED: 'capability',
  AI_RATE_LIMITED: 'rate_limit',
  AI_CONTENT_FILTERED: 'refusal',
  AI_STRUCTURED_OUTPUT_INVALID: 'invalid_output',
  AI_PROVIDER_UNAVAILABLE: 'other',
  AI_INVALID_REQUEST: 'other',
  AI_STORAGE_UNAVAILABLE: 'other',
};

/** Translates what the platform threw; anything that is not an `AiError` is rethrown as it is. */
export function translateAiError(error: unknown): unknown {
  if (!(error instanceof AiError)) return error;
  return new MemoriahubAiError(ERROR_CLASS[error.code] ?? 'other', error.message, error.retryAfterMs);
}

/** The usage of a platform response, `null` where the provider did not report it. */
function toUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): MemoriahubAiUsage {
  return { inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null };
}

/** A port request as the platform takes it. */
function toPlatformRequest(req: MemoriahubAiRequest): AiRequest {
  const input =
    typeof req.input === 'string'
      ? req.input
      : req.input.map((item: MemoriahubAiInputItem) =>
          item.type === 'message'
            ? {
                type: 'message' as const,
                role: item.role,
                content: typeof item.content === 'string' ? [{ type: 'text' as const, text: item.content }] : item.content,
              }
            : item,
        );

  return {
    ...(req.provider !== undefined ? { provider: req.provider } : {}),
    ...(req.model !== undefined ? { model: req.model } : {}),
    ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
    input,
    ...(req.tools !== undefined
      ? {
          tools: req.tools.map((tool) => ({
            type: 'function' as const,
            name: tool.name,
            description: tool.description,
            parameters: isZodType(tool.parameters)
              ? tool.parameters
              : z.fromJSONSchema(tool.parameters as Parameters<typeof z.fromJSONSchema>[0]),
            ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
          })),
        }
      : {}),
    ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.reasoning !== undefined ? { reasoning: req.reasoning } : {}),
    ...(req.providerOptions !== undefined ? { providerOptions: req.providerOptions } : {}),
  } as AiRequest;
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

/** The platform's stream as the port's: text, each tool call once, then one `done`. */
async function* mapStream(stream: AsyncIterable<AiStreamEvent>): AsyncGenerator<MemoriahubAiStreamEvent> {
  const emitted = new Set<string>();
  let done = false;

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'output_text.delta':
          if (event.delta) yield { type: 'text', text: event.delta };
          break;
        case 'output_item.done':
          if (event.item.type === 'function_call' && !emitted.has(event.item.callId)) {
            emitted.add(event.item.callId);
            yield { type: 'tool_call', id: event.item.callId, name: event.item.name, arguments: event.item.arguments };
          }
          break;
        case 'response.completed':
          for (const item of event.response.output) {
            if (item.type === 'function_call' && !emitted.has(item.callId)) {
              emitted.add(item.callId);
              yield { type: 'tool_call', id: item.callId, name: item.name, arguments: item.arguments };
            }
          }
          done = true;
          yield { type: 'done', usage: toUsage(event.response.usage) };
          break;
        case 'error':
          throw new AiError(event.code, event.message);
        default:
          break;
      }
    }
  } catch (error) {
    throw translateAiError(error);
  }

  if (!done) yield { type: 'done' };
}

/** One platform client behind the port. */
class PlatformAiClient implements MemoriahubAiClient {
  constructor(private readonly client: AiUserClient | AiSystemClient) {}

  async respond(req: MemoriahubAiRequest, opts?: MemoriahubAiCallOptions): Promise<MemoriahubAiResponse> {
    try {
      const response = await this.client.respond(toPlatformRequest(req), opts);
      return { outputText: response.outputText, usage: toUsage(response.usage) };
    } catch (error) {
      throw translateAiError(error);
    }
  }

  async respondStructured<S extends z.ZodTypeAny>(
    req: Omit<MemoriahubAiRequest, 'tools'> & { schema: S; schemaName?: string },
    opts?: MemoriahubAiCallOptions,
  ): Promise<MemoriahubAiStructuredResponse<z.output<S>>> {
    try {
      const { schema, schemaName, ...rest } = req;
      const response = await this.client.respondStructured(
        { ...(toPlatformRequest(rest as MemoriahubAiRequest) as object), schema, ...(schemaName !== undefined ? { schemaName } : {}) } as never,
        opts,
      );
      return { parsed: response.parsed as z.output<S>, outputText: response.outputText, usage: toUsage(response.usage) };
    } catch (error) {
      throw translateAiError(error);
    }
  }

  stream(req: MemoriahubAiRequest, opts?: MemoriahubAiCallOptions): AsyncIterable<MemoriahubAiStreamEvent> {
    return mapStream(this.client.stream(toPlatformRequest(req), opts));
  }

  async openStream(req: MemoriahubAiRequest, opts?: MemoriahubAiCallOptions): Promise<AsyncIterable<MemoriahubAiStreamEvent>> {
    try {
      return mapStream(await this.client.openStream(toPlatformRequest(req), opts));
    } catch (error) {
      throw translateAiError(error);
    }
  }

  async embed(
    req: { provider?: string; model: string; input: string | string[] },
    opts?: MemoriahubAiCallOptions,
  ): Promise<MemoriahubAiEmbedResult> {
    try {
      const result = await this.client.embed(req, opts);
      return { model: result.model, vectors: result.vectors };
    } catch (error) {
      throw translateAiError(error);
    }
  }

  async editImageInline(req: MemoriahubAiImageEditRequest, opts?: MemoriahubAiCallOptions): Promise<MemoriahubAiImageResult> {
    try {
      const result = await this.client.editImageInline(req as never, opts);
      return { images: result.images.map((image) => ({ data: image.data, mimeType: image.mimeType })) };
    } catch (error) {
      throw translateAiError(error);
    }
  }

  async transcribeInline(
    req: MemoriahubAiTranscribeRequest,
    opts?: MemoriahubAiCallOptions,
  ): Promise<MemoriahubAiTranscription> {
    try {
      const result = await this.client.transcribeInline(req as never, opts);
      return { text: result.text, ...(result.language !== undefined ? { language: result.language } : {}) };
    } catch (error) {
      throw translateAiError(error);
    }
  }
}

@Injectable()
export class PlatformMemoriahubAiAdapter implements MemoriahubAiPort {
  constructor(private readonly ai: AiService) {}

  forUser(userId: string, scope: MemoriahubAiScope): MemoriahubAiClient {
    return new PlatformAiClient(
      this.ai.forUser(userId, {
        ...(scope.orgId ? { orgId: scope.orgId } : {}),
        feature: scope.feature,
        ...(scope.jobId !== undefined ? { jobId: scope.jobId } : {}),
      }),
    );
  }

  forSystem(scope: MemoriahubAiScope): MemoriahubAiClient {
    return new PlatformAiClient(
      this.ai.forSystem({
        orgId: scope.orgId ?? null,
        feature: scope.feature,
        ...(scope.jobId !== undefined ? { jobId: scope.jobId } : {}),
      }),
    );
  }

  registerFeature(feature: MemoriahubAiFeatureDef): void {
    if (aiFeatureRegistry.has(feature.id)) return;
    registerAiFeature(feature as never);
  }
}
