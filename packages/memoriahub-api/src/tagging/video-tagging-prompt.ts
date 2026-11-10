/**
 * Video auto-tagging prompt (epic #452, issues #455/#460).
 *
 * Moved here from the compute package's former `./ai` subpath when that
 * subpath was removed (J1 / #593): AI calls are server-only (nodes no longer
 * call providers), so the prompt has a single owner. SDK-free by design.
 * Lands in the tagging slice package with J7.
 */

/**
 * System prompt for the video tagging pass.
 *
 * It lived in the shared compute package while a worker node composed the
 * same vision request; AI jobs are server-only now, so the API is its only
 * caller and keeps it. Do not duplicate it into a second place.
 *
 * Same output CONTRACT as the photo prompt — a `{"tags": [...],
 * "description": "..."}` JSON envelope — which is what lets the entire
 * parse/persist half be reused verbatim. What differs is the framing: the
 * model must understand it is looking at ordered stills from ONE video, not a
 * set of unrelated photos.
 *
 * @stability experimental
 */
export const VIDEO_AUTO_TAGGING_SYSTEM_PROMPT =
  'You are a video analysis assistant. You will be shown several still frames sampled in order from a SINGLE video, ' +
  'and optionally a transcript of its opening seconds. Your job is to analyze the video as a whole and return a JSON object ' +
  'with two keys: "tags" and "description". ' +
  '"tags" must be a JSON array of strings — each string must exactly match one of the labels in the provided allowed list; return an empty array if none apply. ' +
  '"description" must be a brief 1-3 sentence description of the video as a whole, not of any single frame. ' +
  'Respond with ONLY a JSON object with those two keys — no explanation, no code fences, no extra text.';

/** Render a millisecond offset as `m:ss`, for the frame-timestamp list. */
function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Build the video tagging user prompt.
 *
 * EXTENDS the photo prompt's contract rather than replacing it: the same
 * `{"tags": [...], "description": "..."}` envelope, the same newline-joined
 * `Allowed labels:` vocabulary, and the same named-people clause. What it adds
 * is the ordered-frames framing, the timestamp of each frame, and — when
 * present — a delimited transcript block. Because the OUTPUT contract is
 * unchanged, the whole parse/persist half is reused verbatim.
 *
 * @stability experimental
 */
export function buildVideoTaggingPrompt(
  labelNames: string[],
  peopleNames: string[],
  sampledTimestampsMs: number[],
  transcript: string | null,
): string {
  const frameList = sampledTimestampsMs.map((ms, i) => `${i + 1}. ${formatTimestamp(ms)}`).join('\n');

  let prompt = `Analyze this video and return a JSON object with two keys: "tags" and "description".

You are shown ${sampledTimestampsMs.length} still frame(s) sampled in order from a single video, at these points in its runtime:
${frameList}

Treat them as one video, not as unrelated photos. Describe what the video as a whole is about.

"tags": an array of applicable labels from the following allowed list. Only choose labels that clearly apply. Return an empty array if none apply.
"description": a brief 1-3 sentence description of the video.

Allowed labels:
${labelNames.join('\n')}

Example response: {"tags": ["label1", "label2"], "description": "A child blows out candles on a birthday cake while family members sing. The video was taken indoors at a decorated dining table."}`;

  if (transcript) {
    prompt += `\n\nTranscript of the video's opening seconds (may be incomplete or misheard — treat it as a hint, not as fact):\n"""\n${transcript}\n"""`;
  }

  if (peopleNames.length > 0) {
    prompt += `\n\nThe following named people appear in this video: ${peopleNames.join(', ')}. Mention them by name in the description where appropriate.`;
  }

  return prompt;
}

/**
 * Output budget for the video vision call.
 *
 * @stability experimental
 */
export const VIDEO_TAGGING_MAX_TOKENS = 2048;
