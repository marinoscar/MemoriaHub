import type { EnhanceParams } from './dto/enhance-params.dto';

type Strength = 'subtle' | 'balanced' | 'strong';

type Preset = NonNullable<EnhanceParams['preset']>;

const STRENGTH_WORD: Record<Strength, string> = {
  subtle: 'subtly',
  balanced: 'noticeably',
  strong: 'strongly',
};

/**
 * Task-specific preset clauses (spec §4.1). Inserted verbatim after the opening
 * sentence and before the adjustment sentence. Presets are ORTHOGONAL to
 * `intent` — they steer WHAT kind of photo problem is being solved, while the
 * adjustment toggles/instructions still steer the individual corrections.
 */
const PRESET_CLAUSE: Record<Preset, string> = {
  // The identity language here is DELIBERATELY heavier than the generic
  // always-on `preserveFaces` sentence, and heavier than any other preset's
  // clause. This preset is pointed at damaged FACES essentially every time it
  // is used, and the generic sentence alone is demonstrably insufficient: the
  // model resolves the conflict between "repair the damage" and "don't alter
  // the face" in favour of repair, and repairs a face by inventing one.
  // Three obligations must survive any rewording (issue #436):
  //   1. name the specific geometry (features, eyes, mouth, jawline), not just
  //      "the face";
  //   2. explicitly PERMIT leaving damage unrepaired on faces — this is what
  //      resolves the conflict above;
  //   3. preserve grain/texture, so a restored face isn't a smooth synthetic
  //      patch on a grainy print.
  restore_old_photo:
    "This is an old or damaged photograph. Repair scratches, dust, creases, tears, stains, and faded areas, and recover lost contrast and detail. Keep the photo's period character — do not modernize it or colorize it unless asked. Do NOT redraw, reshape, re-detail or re-age any face: leave facial features, eyes, mouth, and jawline exactly as they appear in the original, even where they remain soft, blurred, or damaged. It is better to leave a face imperfect than to change who the person looks like. Preserve the original film grain and paper texture.",
  low_light:
    'This photo was taken in low light. Brighten the exposure naturally, recover shadow detail, reduce heavy noise, and correct color casts from artificial lighting, while keeping the night-time or indoor atmosphere believable — do not make it look like daytime.',
  colorize_bw:
    'Colorize this black-and-white photograph with realistic, historically plausible colors: natural skin tones and a restrained, period-appropriate palette. Preserve the original luminance, contrast, and grain character.',
  portrait_polish:
    'This is a portrait. Gently even out skin tone and reduce temporary blemishes while keeping natural skin texture (no plastic smoothing), subtly brighten the eyes, and balance the lighting on the face. Do not reshape facial features, slim the body, or change apparent age.',
};

const DEFAULT_FIDELITY_CONSTRAINT =
  'The output must look like a cleaned-up version of the same photo, not a new image.';

/**
 * `colorize_bw` deliberately changes the photo's color, so the generic
 * "cleaned-up version" framing reads as a contradiction. Every OTHER hard
 * constraint is unchanged.
 */
const COLORIZE_FIDELITY_CONSTRAINT =
  'The output must look like a faithfully colorized version of the same photo, not a new image.';

/**
 * Compile the gpt-image-1 edit prompt from the request params (spec §4.3).
 *
 * Deterministic — the same params always yield the same prompt — so it can be
 * computed once at media_enhancements row-creation time and re-read by the
 * handler, rather than recompiled inside the worker.
 *
 * `intent=auto` uses the fixed base template; `intent=custom` drives the
 * adjustment clauses from the toggles and appends free-text instructions.
 * An optional `preset` adds a task-specific clause between the opening sentence
 * and the adjustment sentence, independently of `intent`.
 * The composition/identity/text hard constraints are ALWAYS present regardless
 * of intent or preset — they are the core safety guardrails of the feature.
 */
export function buildEnhancePrompt(
  params: EnhanceParams,
  effectiveStrength: Strength,
): string {
  const intent = params.intent ?? 'auto';
  const word = STRENGTH_WORD[effectiveStrength];
  const preset = params.preset;
  // Colorizing IS a color change, so the generic white-balance clause and the
  // "cleaned-up version" fidelity constraint would both fight the preset.
  const isColorize = preset === 'colorize_bw';

  // Default toggles: color/tone/sharpness/denoise on, dehaze/straighten off.
  const adj = params.adjustments ?? {};
  const color = (adj.color ?? true) && !isColorize;
  const tone = adj.tone ?? true;
  const sharpness = adj.sharpness ?? true;
  const denoise = adj.denoise ?? true;
  const dehaze = adj.dehaze ?? false;
  const straighten = adj.straighten ?? false;

  const clauses: string[] = [];
  if (tone) clauses.push('balance exposure and recover shadow and highlight detail');
  if (color) clauses.push('correct white balance and color for natural, non-oversaturated tones');
  if (sharpness) clauses.push('increase clarity and sharpness without introducing halos');
  if (denoise) clauses.push('reduce luminance and color noise');
  if (dehaze) clauses.push('reduce atmospheric haze and lift flat contrast');
  if (straighten) clauses.push('level a slightly crooked horizon');

  const adjustmentSentence =
    clauses.length > 0
      ? `${word.charAt(0).toUpperCase()}${word.slice(1)} ${clauses.join(', ')}.`
      : '';

  const preserveFaces = params.preserveFaces ?? true;

  const parts: string[] = [];

  parts.push(
    intent === 'auto'
      ? 'Enhance this photograph to make it look its best while remaining true to the original scene.'
      : 'Enhance this photograph while remaining true to the original scene.',
  );
  if (preset) parts.push(PRESET_CLAUSE[preset]);
  if (adjustmentSentence) parts.push(adjustmentSentence);

  // Always-on hard constraints (spec §4.3).
  const constraints = [
    'Keep the result natural and photorealistic.',
    'Do NOT change the composition or crop.',
    'Do NOT add, remove, or move any people or objects.',
    preserveFaces
      ? "Do NOT alter anyone's face, identity, expression, skin tone, or the number of people."
      : "Do NOT alter anyone's identity or the number of people.",
    'Do NOT add any text, watermark, borders, or artistic filters.',
    isColorize ? COLORIZE_FIDELITY_CONSTRAINT : DEFAULT_FIDELITY_CONSTRAINT,
  ];
  parts.push(constraints.join(' '));

  if (params.intent === 'custom' && params.instructions && params.instructions.trim().length > 0) {
    parts.push(`Additional guidance: ${params.instructions.trim()}`);
  }

  return parts.filter((p) => p && p.length > 0).join(' ');
}

/**
 * Choose the closest supported gpt-image-1 output canvas to the original aspect
 * ratio (spec §4.2). Square, portrait (1024×1536), or landscape (1536×1024).
 */
export function closestSupportedSize(
  width: number | null | undefined,
  height: number | null | undefined,
): '1024x1024' | '1024x1536' | '1536x1024' {
  if (!width || !height || width <= 0 || height <= 0) {
    return '1024x1024';
  }
  const ratio = width / height;
  const candidates: Array<{ size: '1024x1024' | '1024x1536' | '1536x1024'; ratio: number }> = [
    { size: '1024x1024', ratio: 1 },
    { size: '1024x1536', ratio: 1024 / 1536 },
    { size: '1536x1024', ratio: 1536 / 1024 },
  ];
  let best = candidates[0];
  let bestDelta = Math.abs(ratio - best.ratio);
  for (const c of candidates.slice(1)) {
    const delta = Math.abs(ratio - c.ratio);
    if (delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best.size;
}

/** Split a supported size string into [width, height]. */
export function sizeToDims(size: '1024x1024' | '1024x1536' | '1536x1024'): [number, number] {
  const [w, h] = size.split('x').map((n) => parseInt(n, 10));
  return [w, h];
}
