// =============================================================================
// The jobs port over a mocked enqueue facade, for the specs that moved out of the web app
// =============================================================================
//
// The specs of the code that moved asserted `enqueue({ type, mediaItemId, circleId, reason, priority,
// payload, skipDedup })`: the shape of the web app's enrichment facade. The slices now enqueue through
// `MEMORIAHUB_JOBS.enqueue({ type, subjectType, subjectId, reason, priority, payload, skipDedup })`.
// This adapter turns the second into the first so those assertions keep proving the same job rows
// (the subject convention is the media-item, then circle, then none convention of the queue).
// =============================================================================

/** A mocked facade: `enqueue` returns the job row. */
export interface FacadeLike {
  enqueue: jest.Mock;
}

/**
 * Builds a jobs port whose `enqueue` calls the facade mock with the facade's input shape.
 *
 * @param facade - the mock the spec asserts on.
 */
export function jobsPortOverFacade(facade: FacadeLike) {
  return {
    enqueue: async (input: {
      type: string;
      subjectType?: string;
      subjectId?: string;
      reason?: string;
      priority?: number;
      payload?: Record<string, unknown>;
      skipDedup?: boolean;
    }) => {
      const { circleId: payloadCircle, ...rest } = (input.payload ?? {}) as Record<string, unknown>;
      const row = await facade.enqueue({
        type: input.type,
        mediaItemId: input.subjectType === 'media_item' ? (input.subjectId ?? null) : null,
        circleId: input.subjectType === 'circle' ? (input.subjectId ?? null) : ((payloadCircle as string | undefined) ?? null),
        reason: input.reason,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(Object.keys(rest).length > 0 ? { payload: rest } : {}),
        ...(input.skipDedup ? { skipDedup: true } : {}),
      });
      return { id: (row as { id?: string } | undefined)?.id ?? 'job-1', deduplicated: false };
    },
    registerHandler: jest.fn(),
  };
}
