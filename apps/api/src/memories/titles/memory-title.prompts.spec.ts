/**
 * Prompt-builder tests (epic #300, issue #306).
 *
 * The per-type snapshots are the point of this file. A prompt has no type
 * errors and no test failures of its own, so a wording change — a dropped fact,
 * a re-ordered block, a new field quietly added to the context — is invisible in
 * a diff unless the rendered output is asserted somewhere. #306 asks for exactly
 * this: "unit-test the builder output snapshot per memory type so prompt drift
 * is visible in review."
 *
 * The remaining tests guard the two properties snapshots cannot: the input caps
 * are enforced by the BUILDER (so no call site can widen what is sent), and the
 * privacy boundary holds (no ids of any kind reach the prompt).
 */

import { MemoryType } from '@prisma/client';
import {
  DESCRIPTION_MAX_CHARS,
  MAX_PROMPT_DESCRIPTIONS,
  MAX_PROMPT_PERSON_NAMES,
  MAX_PROMPT_TAGS,
  MEMORY_TITLE_SYSTEM_PROMPT,
  MemoryTitleFacts,
  NARRATIVE_MAX_CHARS,
  SUBTITLE_MAX_CHARS,
  TITLE_MAX_CHARS,
  buildMemoryTitleUserPrompt,
} from './memory-title.prompts';

function facts(over: Partial<MemoryTitleFacts> = {}): MemoryTitleFacts {
  return {
    type: MemoryType.on_this_day,
    itemCount: 8,
    periodStart: new Date('2019-03-12T09:00:00.000Z'),
    periodEnd: new Date('2019-03-12T21:30:00.000Z'),
    templateTitle: 'On this day — 6 years ago',
    templateSubtitle: 'March 12, 2019',
    place: null,
    personNames: [],
    topTags: [],
    descriptions: [],
    yearsAgo: null,
    themeTag: null,
    season: null,
    year: null,
    ...over,
  };
}

describe('MEMORY_TITLE_SYSTEM_PROMPT', () => {
  it('states the JSON contract and every length cap the parser enforces', () => {
    // The caps live in ONE place and are both told to the model and enforced on
    // parse; a cap changed in only one of those two spots is the bug this guards.
    expect(MEMORY_TITLE_SYSTEM_PROMPT).toContain(String(TITLE_MAX_CHARS));
    expect(MEMORY_TITLE_SYSTEM_PROMPT).toContain(String(SUBTITLE_MAX_CHARS));
    expect(MEMORY_TITLE_SYSTEM_PROMPT).toContain(String(NARRATIVE_MAX_CHARS));
    expect(MEMORY_TITLE_SYSTEM_PROMPT).toContain('{"title": string, "subtitle": string, "narrative": string}');
  });

  it('carries the tone rules the epic asked for', () => {
    expect(MEMORY_TITLE_SYSTEM_PROMPT).toMatch(/No emojis/);
    expect(MEMORY_TITLE_SYSTEM_PROMPT).toMatch(/exclamation marks/);
    expect(MEMORY_TITLE_SYSTEM_PROMPT).toMatch(/family photo app/);
  });

  it('is a stable constant', () => {
    expect(MEMORY_TITLE_SYSTEM_PROMPT).toMatchSnapshot();
  });
});

describe('buildMemoryTitleUserPrompt — per-type snapshots', () => {
  it('on_this_day', () => {
    expect(
      buildMemoryTitleUserPrompt(
        facts({
          type: MemoryType.on_this_day,
          yearsAgo: 6,
          topTags: [
            { name: 'beach', count: 6 },
            { name: 'sunset', count: 3 },
          ],
          descriptions: ['Two children building a sandcastle at the water line.'],
          personNames: ['Camila'],
        }),
      ),
    ).toMatchSnapshot();
  });

  it('trip', () => {
    expect(
      buildMemoryTitleUserPrompt(
        facts({
          type: MemoryType.trip,
          itemCount: 24,
          periodStart: new Date('2023-03-04T00:00:00.000Z'),
          periodEnd: new Date('2023-03-09T00:00:00.000Z'),
          templateTitle: 'Trip to Guanacaste',
          templateSubtitle: 'March 2023',
          place: { locality: 'Tamarindo', admin1: 'Guanacaste', country: 'Costa Rica' },
          personNames: ['Camila', 'Abuela'],
          topTags: [
            { name: 'beach', count: 14 },
            { name: 'surf', count: 5 },
          ],
          descriptions: ['A long stretch of empty beach at golden hour.'],
        }),
      ),
    ).toMatchSnapshot();
  });

  it('person_highlights', () => {
    expect(
      buildMemoryTitleUserPrompt(
        facts({
          type: MemoryType.person_highlights,
          templateTitle: 'Best of Abuela',
          templateSubtitle: '2025',
          year: 2025,
          personNames: ['Abuela'],
          periodStart: new Date('2025-01-06T00:00:00.000Z'),
          periodEnd: new Date('2025-12-22T00:00:00.000Z'),
        }),
      ),
    ).toMatchSnapshot();
  });

  it('person_over_years', () => {
    expect(
      buildMemoryTitleUserPrompt(
        facts({
          type: MemoryType.person_over_years,
          templateTitle: 'Camila through the years',
          templateSubtitle: '2016–2025',
          personNames: ['Camila'],
          periodStart: new Date('2016-05-02T00:00:00.000Z'),
          periodEnd: new Date('2025-11-30T00:00:00.000Z'),
        }),
      ),
    ).toMatchSnapshot();
  });

  it('theme', () => {
    expect(
      buildMemoryTitleUserPrompt(
        facts({
          type: MemoryType.theme,
          templateTitle: 'Golden Sunsets',
          templateSubtitle: '14 favorite moments',
          themeTag: 'sunset',
          year: 2025,
          topTags: [{ name: 'sunset', count: 14 }],
        }),
      ),
    ).toMatchSnapshot();
  });

  it('seasonal', () => {
    expect(
      buildMemoryTitleUserPrompt(
        facts({
          type: MemoryType.seasonal,
          templateTitle: 'Summer 2025',
          templateSubtitle: null,
          season: 'summer',
          year: 2025,
          periodStart: new Date('2025-06-02T00:00:00.000Z'),
          periodEnd: new Date('2025-08-28T00:00:00.000Z'),
        }),
      ),
    ).toMatchSnapshot();
  });

  it('year_in_review', () => {
    expect(
      buildMemoryTitleUserPrompt(
        facts({
          type: MemoryType.year_in_review,
          itemCount: 30,
          templateTitle: 'Your 2025 in review',
          templateSubtitle: '30 highlights from the year',
          year: 2025,
          periodStart: new Date('2025-01-01T00:00:00.000Z'),
          periodEnd: new Date('2025-12-31T00:00:00.000Z'),
        }),
      ),
    ).toMatchSnapshot();
  });

  it('renders a single-day range as one date, not "X to X"', () => {
    const prompt = buildMemoryTitleUserPrompt(
      facts({
        periodStart: new Date('2019-03-12T09:00:00.000Z'),
        periodEnd: new Date('2019-03-12T21:30:00.000Z'),
      }),
    );
    expect(prompt).toContain('Date: 2019-03-12');
    expect(prompt).not.toContain(' to ');
  });

  it('omits every optional block when the facts are empty (new install)', () => {
    const prompt = buildMemoryTitleUserPrompt(
      facts({ periodStart: null, periodEnd: null, templateSubtitle: null }),
    );
    expect(prompt).not.toMatch(/Place:|People pictured:|Common tags:|Sample photo descriptions:/);
    expect(prompt).toContain('Fallback title: On this day — 6 years ago');
  });
});

describe('buildMemoryTitleUserPrompt — input caps are enforced by the builder', () => {
  it('sends at most MAX_PROMPT_TAGS tags', () => {
    const prompt = buildMemoryTitleUserPrompt(
      facts({
        topTags: Array.from({ length: MAX_PROMPT_TAGS + 5 }, (_, i) => ({
          name: `tag${i}`,
          count: 100 - i,
        })),
      }),
    );
    const line = prompt.split('\n').find((l) => l.startsWith('Common tags:'))!;
    expect(line.split(', ')).toHaveLength(MAX_PROMPT_TAGS);
    expect(line).not.toContain(`tag${MAX_PROMPT_TAGS}`);
  });

  it('sends at most MAX_PROMPT_DESCRIPTIONS descriptions', () => {
    const prompt = buildMemoryTitleUserPrompt(
      facts({
        descriptions: Array.from({ length: MAX_PROMPT_DESCRIPTIONS + 4 }, (_, i) => `desc ${i}`),
      }),
    );
    expect(prompt.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(
      MAX_PROMPT_DESCRIPTIONS,
    );
  });

  it('truncates each description to DESCRIPTION_MAX_CHARS', () => {
    const prompt = buildMemoryTitleUserPrompt(facts({ descriptions: ['x'.repeat(900)] }));
    const line = prompt.split('\n').find((l) => l.startsWith('- '))!;
    expect(line.length - 2).toBe(DESCRIPTION_MAX_CHARS);
    expect(line.endsWith('…')).toBe(true);
  });

  it('sends at most MAX_PROMPT_PERSON_NAMES names', () => {
    const prompt = buildMemoryTitleUserPrompt(
      facts({ personNames: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
    );
    const line = prompt.split('\n').find((l) => l.startsWith('People pictured:'))!;
    expect(line.slice('People pictured: '.length).split(', ')).toHaveLength(
      MAX_PROMPT_PERSON_NAMES,
    );
  });

  it('collapses newlines inside a description so the "- " list stays one line each', () => {
    const prompt = buildMemoryTitleUserPrompt(
      facts({ descriptions: ['first line\nsecond line\n\nthird'] }),
    );
    expect(prompt.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
    expect(prompt).toContain('- first line second line third');
  });
});

describe('buildMemoryTitleUserPrompt — privacy boundary', () => {
  it('cannot leak ids: the facts type has no field to carry one', () => {
    // MemoryTitleFacts is the COMPLETE list of what may be sent. Media item
    // ids, the circle id, the person id and storage keys are absent by
    // construction — this asserts the rendered output over a maximal fact set.
    const prompt = buildMemoryTitleUserPrompt(
      facts({
        type: MemoryType.trip,
        place: { locality: 'Tamarindo', admin1: 'Guanacaste', country: 'Costa Rica' },
        personNames: ['Camila'],
        topTags: [{ name: 'beach', count: 4 }],
        descriptions: ['A beach at golden hour.'],
        yearsAgo: 6,
        year: 2023,
        season: 'summer',
        themeTag: 'sunset',
      }),
    );
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
