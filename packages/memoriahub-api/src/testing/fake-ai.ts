import type { z } from 'zod';

import {
  MemoriahubAiError,
  type MemoriahubAiCallOptions,
  type MemoriahubAiClient,
  type MemoriahubAiEmbedResult,
  type MemoriahubAiErrorClass,
  type MemoriahubAiImageEditRequest,
  type MemoriahubAiImageResult,
  type MemoriahubAiPort,
  type MemoriahubAiRequest,
  type MemoriahubAiResponse,
  type MemoriahubAiScope,
  type MemoriahubAiStreamEvent,
  type MemoriahubAiStructuredResponse,
  type MemoriahubAiTranscribeRequest,
  type MemoriahubAiTranscription,
} from '../ports/index.js';

/**
 * One call a {@link FakeMemoriahubAi} recorded.
 *
 * @stability experimental
 */
export interface FakeAiCall {
  /** Which client method. */
  method: 'respond' | 'respondStructured' | 'stream' | 'openStream' | 'embed' | 'editImageInline' | 'transcribeInline';
  /** `user` for `forUser`, `system` for `forSystem`. */
  kind: 'user' | 'system';
  /** The acting user, for a user call. */
  userId?: string;
  /** The scope the call was made under. */
  scope: MemoriahubAiScope;
}

/**
 * A scripted `MEMORIAHUB_AI`. Answers are queued or defaulted; `failNext(errorClass)` makes the next
 * call throw a {@link MemoriahubAiError}. It never holds a credential, and a call refuses a feature the
 * host did not register when `strictFeatures` is on.
 *
 * @stability experimental
 */
export class FakeMemoriahubAi implements MemoriahubAiPort {
  /** Every call, in order. */
  readonly calls: FakeAiCall[] = [];

  /** The registered features. */
  readonly features = new Map<string, { id: string; label: string; description?: string; systemCalls?: boolean }>();

  /** The text `respond` answers with. */
  responseText = 'ok';

  /** The text deltas a stream emits. */
  streamTexts: string[] = ['ok'];

  /** The tool calls a stream emits after its text. */
  streamToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  /** The vector `embed` answers with, per input. */
  vector: number[] = [0.1, 0.2, 0.3];

  /** The value `respondStructured` answers with. */
  structuredValue: unknown = {};

  private failure: { errorClass: MemoriahubAiErrorClass; retryAfterMs?: number } | null = null;

  /**
   * Makes the next call fail.
   *
   * @param errorClass - the class of the failure.
   * @param retryAfterMs - the provider's hint, for `rate_limit`.
   */
  failNext(errorClass: MemoriahubAiErrorClass, retryAfterMs?: number): void {
    this.failure = { errorClass, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }

  /**
   * The client of a user call.
   *
   * @param userId - the acting user.
   * @param scope - the feature, the organization and the job.
   */
  forUser(userId: string, scope: MemoriahubAiScope): MemoriahubAiClient {
    return this.client('user', scope, userId);
  }

  /**
   * The client of a system call.
   *
   * @param scope - the feature, the organization and the job.
   */
  forSystem(scope: MemoriahubAiScope): MemoriahubAiClient {
    return this.client('system', scope);
  }

  /**
   * Declares a feature.
   *
   * @param feature - the feature.
   */
  registerFeature(feature: { id: string; label: string; description?: string; systemCalls?: boolean }): void {
    this.features.set(feature.id, feature);
  }

  private take(call: FakeAiCall): void {
    this.calls.push(call);
    const failure = this.failure;
    this.failure = null;
    if (failure) {
      throw new MemoriahubAiError(failure.errorClass, `Scripted ${failure.errorClass} failure`, failure.retryAfterMs);
    }
  }

  private client(kind: 'user' | 'system', scope: MemoriahubAiScope, userId?: string): MemoriahubAiClient {
    const record = (method: FakeAiCall['method']): FakeAiCall => ({ method, kind, ...(userId !== undefined ? { userId } : {}), scope });
    const events = (): MemoriahubAiStreamEvent[] => [
      ...this.streamTexts.map((text): MemoriahubAiStreamEvent => ({ type: 'text', text })),
      ...this.streamToolCalls.map((call): MemoriahubAiStreamEvent => ({ type: 'tool_call', ...call })),
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    const self = this;

    return {
      async respond(_req: MemoriahubAiRequest, _opts?: MemoriahubAiCallOptions): Promise<MemoriahubAiResponse> {
        self.take(record('respond'));
        return { outputText: self.responseText, usage: { inputTokens: 10, outputTokens: 5 } };
      },
      async respondStructured<S extends z.ZodTypeAny>(
        req: Omit<MemoriahubAiRequest, 'tools'> & { schema: S; schemaName?: string },
      ): Promise<MemoriahubAiStructuredResponse<z.output<S>>> {
        self.take(record('respondStructured'));
        const parsed = req.schema.safeParse(self.structuredValue);
        if (!parsed.success) throw new MemoriahubAiError('invalid_output', 'The structured answer did not match the schema');
        return { parsed: parsed.data, outputText: JSON.stringify(self.structuredValue) };
      },
      stream(_req: MemoriahubAiRequest): AsyncIterable<MemoriahubAiStreamEvent> {
        return (async function* () {
          self.take(record('stream'));
          yield* events();
        })();
      },
      async openStream(_req: MemoriahubAiRequest): Promise<AsyncIterable<MemoriahubAiStreamEvent>> {
        self.take(record('openStream'));
        return (async function* () {
          yield* events();
        })();
      },
      async embed(req: { provider?: string; model: string; input: string | string[] }): Promise<MemoriahubAiEmbedResult> {
        self.take(record('embed'));
        const inputs = Array.isArray(req.input) ? req.input : [req.input];
        return { model: req.model, vectors: inputs.map(() => [...self.vector]) };
      },
      async editImageInline(req: MemoriahubAiImageEditRequest): Promise<MemoriahubAiImageResult> {
        self.take(record('editImageInline'));
        return { images: [{ data: new Uint8Array(req.images[0]?.data ?? [1]), mimeType: 'image/jpeg' }] };
      },
      async transcribeInline(_req: MemoriahubAiTranscribeRequest): Promise<MemoriahubAiTranscription> {
        self.take(record('transcribeInline'));
        return { text: 'hello world', language: 'en' };
      },
    };
  }
}
