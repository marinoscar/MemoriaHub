/**
 * Response-parsing tests (epic #300, issue #306).
 *
 * `parseMemoryTitleResponse` is the single place a model's answer becomes a
 * value the app will persist, and #306 requires it to be TOTAL: every malformed
 * shape resolves to `null` ("use the template"), never to an exception. These
 * tests enumerate the shapes real models actually emit — a ```json fence, a
 * chatty preamble, a `null` subtitle, a 400-character title — plus the
 * degenerate ones, and assert that none of them throw.
 */

import {
  capText,
  extractJsonObject,
  parseMemoryTitleResponse,
} from './memory-title.parse';
import {
  NARRATIVE_MAX_CHARS,
  SUBTITLE_MAX_CHARS,
  TITLE_MAX_CHARS,
} from './memory-title.prompts';

describe('extractJsonObject', () => {
  it('passes a bare object through', () => {
    expect(extractJsonObject('{"title":"x"}')).toBe('{"title":"x"}');
  });

  it('strips a ```json fence', () => {
    expect(extractJsonObject('```json\n{"title":"x"}\n```')).toBe('{"title":"x"}');
  });

  it('strips a bare ``` fence', () => {
    expect(extractJsonObject('```\n{"title":"x"}\n```')).toBe('{"title":"x"}');
  });

  it('slices away a chatty preamble and sign-off', () => {
    expect(extractJsonObject('Sure! Here you go:\n{"title":"x"}\nHope that helps.')).toBe(
      '{"title":"x"}',
    );
  });

  it('returns null when there is no brace pair', () => {
    expect(extractJsonObject('I cannot help with that.')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('} {')).toBeNull();
  });
});

describe('capText', () => {
  it('collapses whitespace', () => {
    expect(capText('  a \n b\tc  ', 50)).toBe('a b c');
  });

  it('truncates with an ellipsis and never exceeds the cap', () => {
    const capped = capText('x'.repeat(200), 60);
    expect(capped).toHaveLength(60);
    expect(capped.endsWith('…')).toBe(true);
  });
});

describe('parseMemoryTitleResponse — success', () => {
  it('parses the well-formed happy path', () => {
    expect(
      parseMemoryTitleResponse(
        '{"title":"Five golden days","subtitle":"Tamarindo, March 2023","narrative":"Sunsets and surf."}',
      ),
    ).toEqual({
      title: 'Five golden days',
      subtitle: 'Tamarindo, March 2023',
      narrative: 'Sunsets and surf.',
    });
  });

  it('parses through a fence and a preamble', () => {
    expect(
      parseMemoryTitleResponse('Here:\n```json\n{"title":"A quiet week"}\n```\nDone.'),
    ).toEqual({ title: 'A quiet week', subtitle: null, narrative: null });
  });

  it('normalizes a null / empty / whitespace subtitle and narrative to null', () => {
    expect(
      parseMemoryTitleResponse('{"title":"T","subtitle":null,"narrative":"   "}'),
    ).toEqual({ title: 'T', subtitle: null, narrative: null });
  });

  it('enforces every length cap regardless of what the model returned', () => {
    const parsed = parseMemoryTitleResponse(
      JSON.stringify({
        title: 'a'.repeat(400),
        subtitle: 'b'.repeat(400),
        narrative: 'c'.repeat(4000),
      }),
    )!;
    expect(parsed.title).toHaveLength(TITLE_MAX_CHARS);
    expect(parsed.subtitle).toHaveLength(SUBTITLE_MAX_CHARS);
    expect(parsed.narrative).toHaveLength(NARRATIVE_MAX_CHARS);
  });

  it('recovers the object from a single-element array wrapper', () => {
    // A by-product of the first-brace/last-brace slice, and a welcome one: a
    // model that wrapped its answer in an array still produced a usable title.
    expect(parseMemoryTitleResponse('[{"title":"x"}]')).toEqual({
      title: 'x',
      subtitle: null,
      narrative: null,
    });
  });

  it('collapses embedded newlines — these are single-line UI fields', () => {
    expect(parseMemoryTitleResponse('{"title":"A\\nB"}')!.title).toBe('A B');
  });
});

describe('parseMemoryTitleResponse — every failure returns null, never throws', () => {
  const cases: Array<[string, string]> = [
    ['empty output', ''],
    ['prose with no JSON', 'I am sorry, I cannot do that.'],
    ['truncated JSON', '{"title":"unfinished'],
    ['an object missing "title"', '{"subtitle":"x","narrative":"y"}'],
    ['a non-string title', '{"title":42}'],
    ['a null title', '{"title":null}'],
    ['an empty title', '{"title":""}'],
    ['a whitespace-only title', '{"title":"   "}'],
    ['trailing-comma JSON', '{"title":"x",}'],
    ['a JSON string, not an object', '"just a string"'],
  ];

  it.each(cases)('%s', (_label, raw) => {
    expect(() => parseMemoryTitleResponse(raw)).not.toThrow();
    expect(parseMemoryTitleResponse(raw)).toBeNull();
  });

  it('ignores unexpected extra keys rather than rejecting the response', () => {
    // Rejecting on an extra key would turn a usable answer into a template
    // fallback for no benefit — strictness here buys nothing.
    expect(
      parseMemoryTitleResponse('{"title":"T","confidence":0.9,"tags":["a"]}'),
    ).toEqual({ title: 'T', subtitle: null, narrative: null });
  });
});
