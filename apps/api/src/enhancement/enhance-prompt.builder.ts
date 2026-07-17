import type { EnhanceParams } from './dto/enhance-params.dto';

type Strength = 'subtle' | 'balanced' | 'strong';

const STRENGTH_WORD: Record<Strength, string> = {
  subtle: 'subtly',
  balanced: 'noticeably',
  strong: 'strongly',
};

/**
 * Compile the gpt-image-1 edit prompt from the request params (spec §4.3).
 *
 * Deterministic — the same params always yield the same prompt — so it can be
 * computed once at media_enhancements row-creation time and re-read by the
 * handler, rather than recompiled inside the worker.
 *
 * `intent=auto` uses the fixed base template; `intent=custom` drives the
 * adjustment clauses from the toggles and appends free-text instructions.
 * The composition/identity/text hard constraints are ALWAYS present regardless
 * of intent — they are the core safety guardrails of the feature.
 */
export function buildEnhancePrompt(
  params: EnhanceParams,
  effectiveStrength: Strength,
): string {
  const intent = params.intent ?? 'auto';
  const word = STRENGTH_WORD[effectiveStrength];

  // Default toggles: color/tone/sharpness/denoise on, dehaze/straighten off.
  const adj = params.adjustments ?? {};
  const color = adj.color ?? true;
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

  if (intent === 'auto' && clauses.length === 0) {
    parts.push(
      'Enhance this photograph to make it look its best while remaining true to the original scene.',
    );
  } else if (intent === 'auto') {
    parts.push(
      'Enhance this photograph to make it look its best while remaining true to the original scene.',
    );
    parts.push(adjustmentSentence);
  } else {
    parts.push('Enhance this photograph while remaining true to the original scene.');
    if (adjustmentSentence) parts.push(adjustmentSentence);
  }

  // Always-on hard constraints (spec §4.3).
  const constraints = [
    'Keep the result natural and photorealistic.',
    'Do NOT change the composition or crop.',
    'Do NOT add, remove, or move any people or objects.',
    preserveFaces
      ? "Do NOT alter anyone's face, identity, expression, skin tone, or the number of people."
      : "Do NOT alter anyone's identity or the number of people.",
    'Do NOT add any text, watermark, borders, or artistic filters.',
    'The output must look like a cleaned-up version of the same photo, not a new image.',
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
