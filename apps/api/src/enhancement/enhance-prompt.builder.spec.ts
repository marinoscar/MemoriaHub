/**
 * Unit tests for the deterministic enhance-prompt builder (spec §4.2/§4.3).
 *
 * Pure functions, no mocking required.
 *   - buildEnhancePrompt: auto vs custom intent, adjustment-toggle clauses
 *     (including the off-by-default dehaze/straighten toggles), strength
 *     wording, always-on hard constraints, preserveFaces wording, and the
 *     custom free-text `instructions` append rule.
 *   - closestSupportedSize: nearest-aspect-ratio selection for landscape /
 *     portrait / square inputs, plus the null/zero-dimension fallback.
 *   - sizeToDims: string -> [width, height] split.
 */

import { buildEnhancePrompt, closestSupportedSize, sizeToDims } from './enhance-prompt.builder';
import type { EnhanceParams } from './dto/enhance-params.dto';

describe('buildEnhancePrompt', () => {
  describe('auto intent (default toggles: color/tone/sharpness/denoise on, dehaze/straighten off)', () => {
    it('composes the base sentence + adjustment clauses in fixed order (tone, color, sharpness, denoise)', () => {
      const prompt = buildEnhancePrompt({}, 'balanced');

      expect(prompt).toContain(
        'Enhance this photograph to make it look its best while remaining true to the original scene.',
      );
      // Clause order matches the handler's fixed push order.
      const clausesIndex = prompt.indexOf('Noticeably');
      expect(clausesIndex).toBeGreaterThan(-1);
      const toneIdx = prompt.indexOf('balance exposure and recover shadow and highlight detail');
      const colorIdx = prompt.indexOf('correct white balance and color for natural, non-oversaturated tones');
      const sharpnessIdx = prompt.indexOf('increase clarity and sharpness without introducing halos');
      const denoiseIdx = prompt.indexOf('reduce luminance and color noise');
      expect(toneIdx).toBeGreaterThan(-1);
      expect(toneIdx).toBeLessThan(colorIdx);
      expect(colorIdx).toBeLessThan(sharpnessIdx);
      expect(sharpnessIdx).toBeLessThan(denoiseIdx);
    });

    it('does NOT include the dehaze or straighten clauses when not explicitly toggled on', () => {
      const prompt = buildEnhancePrompt({}, 'balanced');

      expect(prompt).not.toContain('reduce atmospheric haze');
      expect(prompt).not.toContain('level a slightly crooked horizon');
    });

    it('includes the dehaze clause when adjustments.dehaze is true', () => {
      const params: EnhanceParams = { adjustments: { dehaze: true } };
      const prompt = buildEnhancePrompt(params, 'balanced');

      expect(prompt).toContain('reduce atmospheric haze and lift flat contrast');
    });

    it('includes the straighten clause when adjustments.straighten is true', () => {
      const params: EnhanceParams = { adjustments: { straighten: true } };
      const prompt = buildEnhancePrompt(params, 'balanced');

      expect(prompt).toContain('level a slightly crooked horizon');
    });

    it('omits a clause when its toggle is explicitly set to false', () => {
      const params: EnhanceParams = {
        adjustments: { color: false, tone: false, sharpness: false, denoise: false },
      };
      const prompt = buildEnhancePrompt(params, 'balanced');

      expect(prompt).not.toContain('balance exposure and recover shadow');
      expect(prompt).not.toContain('correct white balance');
      expect(prompt).not.toContain('increase clarity and sharpness');
      expect(prompt).not.toContain('reduce luminance and color noise');
    });

    it('falls back to the bare base sentence (no adjustment sentence) when every toggle is off', () => {
      const params: EnhanceParams = {
        adjustments: {
          color: false,
          tone: false,
          sharpness: false,
          denoise: false,
          dehaze: false,
          straighten: false,
        },
      };
      const prompt = buildEnhancePrompt(params, 'balanced');

      expect(prompt).toContain(
        'Enhance this photograph to make it look its best while remaining true to the original scene.',
      );
      expect(prompt).not.toMatch(/Subtly|Noticeably|Strongly/);
    });
  });

  describe('strength wording', () => {
    it.each([
      ['subtle', 'Subtly'],
      ['balanced', 'Noticeably'],
      ['strong', 'Strongly'],
    ] as const)('renders %s strength as "%s ..." at the start of the adjustment sentence', (strength, word) => {
      const prompt = buildEnhancePrompt({}, strength);
      expect(prompt).toContain(`${word} balance exposure`);
    });
  });

  describe('custom intent', () => {
    it('uses the shorter custom base sentence (no "make it look its best" framing)', () => {
      const params: EnhanceParams = { intent: 'custom' };
      const prompt = buildEnhancePrompt(params, 'balanced');

      expect(prompt).toContain('Enhance this photograph while remaining true to the original scene.');
      expect(prompt).not.toContain('make it look its best');
    });

    it('appends free-text instructions when intent=custom and instructions are non-blank', () => {
      const params: EnhanceParams = { intent: 'custom', instructions: '  make the sky bluer  ' };
      const prompt = buildEnhancePrompt(params, 'balanced');

      expect(prompt).toContain('Additional guidance: make the sky bluer');
    });

    it('does NOT append guidance for whitespace-only instructions', () => {
      const params: EnhanceParams = { intent: 'custom', instructions: '   ' };
      const prompt = buildEnhancePrompt(params, 'balanced');

      expect(prompt).not.toContain('Additional guidance');
    });

    it('does NOT append instructions when intent is left as auto (default), even if instructions are set', () => {
      const params: EnhanceParams = { instructions: 'make the sky bluer' };
      const prompt = buildEnhancePrompt(params, 'balanced');

      expect(prompt).not.toContain('Additional guidance');
    });
  });

  describe('always-on hard constraints', () => {
    it('always includes the composition/identity/text guardrails regardless of intent', () => {
      const prompt = buildEnhancePrompt({ intent: 'custom' }, 'balanced');

      expect(prompt).toContain('Keep the result natural and photorealistic.');
      expect(prompt).toContain('Do NOT change the composition or crop.');
      expect(prompt).toContain('Do NOT add, remove, or move any people or objects.');
      expect(prompt).toContain('Do NOT add any text, watermark, borders, or artistic filters.');
      expect(prompt).toContain('The output must look like a cleaned-up version of the same photo, not a new image.');
    });

    it('uses the strict face-preservation wording when preserveFaces is true (default)', () => {
      const prompt = buildEnhancePrompt({}, 'balanced');
      expect(prompt).toContain(
        "Do NOT alter anyone's face, identity, expression, skin tone, or the number of people.",
      );
    });

    it('relaxes to identity-only wording when preserveFaces is explicitly false', () => {
      const prompt = buildEnhancePrompt({ preserveFaces: false }, 'balanced');
      expect(prompt).toContain("Do NOT alter anyone's identity or the number of people.");
      expect(prompt).not.toContain('face, identity, expression, skin tone');
    });
  });

  it('is deterministic — identical params + strength always yield an identical prompt', () => {
    const params: EnhanceParams = { intent: 'custom', adjustments: { dehaze: true }, instructions: 'warmer tones' };
    const a = buildEnhancePrompt(params, 'strong');
    const b = buildEnhancePrompt(params, 'strong');
    expect(a).toBe(b);
  });
});

describe('closestSupportedSize', () => {
  it('picks the square canvas for a 1:1 input', () => {
    expect(closestSupportedSize(1000, 1000)).toBe('1024x1024');
  });

  it('picks the landscape canvas for a wide (16:9) input', () => {
    expect(closestSupportedSize(1920, 1080)).toBe('1536x1024');
  });

  it('picks the portrait canvas for a tall (9:16) input', () => {
    expect(closestSupportedSize(1080, 1920)).toBe('1024x1536');
  });

  it('picks the landscape canvas for a moderately wide (4:3) input (closest by ratio distance)', () => {
    expect(closestSupportedSize(1200, 900)).toBe('1536x1024');
  });

  it('picks the portrait canvas for a moderately tall (3:4) input', () => {
    expect(closestSupportedSize(900, 1200)).toBe('1024x1536');
  });

  it('falls back to square when width is missing', () => {
    expect(closestSupportedSize(null, 1000)).toBe('1024x1024');
  });

  it('falls back to square when height is missing', () => {
    expect(closestSupportedSize(1000, undefined)).toBe('1024x1024');
  });

  it('falls back to square when width is zero or negative', () => {
    expect(closestSupportedSize(0, 1000)).toBe('1024x1024');
    expect(closestSupportedSize(-100, 1000)).toBe('1024x1024');
  });
});

describe('sizeToDims', () => {
  it('splits "1024x1024" into [1024, 1024]', () => {
    expect(sizeToDims('1024x1024')).toEqual([1024, 1024]);
  });

  it('splits "1024x1536" into [1024, 1536]', () => {
    expect(sizeToDims('1024x1536')).toEqual([1024, 1536]);
  });

  it('splits "1536x1024" into [1536, 1024]', () => {
    expect(sizeToDims('1536x1024')).toEqual([1536, 1024]);
  });
});
