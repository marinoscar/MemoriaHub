import {
  isMemoryHiddenByPreferences,
  preferencesAreEmpty,
  resolveMemoryPreferences,
} from './memory-preferences';

function memory(start: string, end: string, personId: string | null = null) {
  return {
    personId,
    periodStart: new Date(start),
    periodEnd: new Date(end),
  };
}

describe('resolveMemoryPreferences', () => {
  it('treats an absent namespace as "no preference"', () => {
    for (const input of [undefined, null, {}]) {
      const prefs = resolveMemoryPreferences(input as never);
      expect(preferencesAreEmpty(prefs)).toBe(true);
      expect(prefs.emailDigestOptOut).toBe(false);
    }
  });

  it('compiles person ids into a Set', () => {
    const prefs = resolveMemoryPreferences({
      hiddenPersonIds: ['a', 'b', 'a'],
    });
    expect(prefs.hiddenPersonIds.size).toBe(2);
    expect(prefs.hiddenPersonIds.has('a')).toBe(true);
  });

  it('expands an inclusive `to` day to the next UTC midnight', () => {
    const prefs = resolveMemoryPreferences({
      hiddenDateRanges: [{ from: '2024-05-10', to: '2024-05-10' }],
    });
    expect(prefs.hiddenRanges).toEqual([
      {
        startMs: Date.parse('2024-05-10T00:00:00.000Z'),
        endExclusiveMs: Date.parse('2024-05-11T00:00:00.000Z'),
      },
    ]);
  });

  it('skips malformed entries rather than throwing', () => {
    // Simulates a hand-edited / legacy JSONB blob: the schema validates on
    // WRITE, but a read must degrade to "no filter", never 500 a browse page.
    const prefs = resolveMemoryPreferences({
      hiddenPersonIds: [null, 42, 'ok'],
      hiddenDateRanges: [
        null,
        { from: 'nonsense', to: 'nonsense' },
        { from: '2024-01-02', to: '2024-01-01' }, // inverted
        { from: '2024-03-01', to: '2024-03-02' },
      ],
    } as never);
    expect([...prefs.hiddenPersonIds]).toEqual(['ok']);
    expect(prefs.hiddenRanges).toHaveLength(1);
  });

  it('reads emailDigestOptOut strictly as true', () => {
    expect(resolveMemoryPreferences({ emailDigestOptOut: true }).emailDigestOptOut).toBe(true);
    expect(resolveMemoryPreferences({ emailDigestOptOut: false }).emailDigestOptOut).toBe(false);
    expect(resolveMemoryPreferences({}).emailDigestOptOut).toBe(false);
  });
});

describe('isMemoryHiddenByPreferences', () => {
  it('hides a memory keyed to a hidden person', () => {
    const prefs = resolveMemoryPreferences({ hiddenPersonIds: ['p1'] });
    expect(
      isMemoryHiddenByPreferences(memory('2024-01-01', '2024-01-02', 'p1'), prefs),
    ).toBe(true);
    expect(
      isMemoryHiddenByPreferences(memory('2024-01-01', '2024-01-02', 'p2'), prefs),
    ).toBe(false);
    // A memory with no person is never hidden by a person preference.
    expect(
      isMemoryHiddenByPreferences(memory('2024-01-01', '2024-01-02'), prefs),
    ).toBe(false);
  });

  describe('date-range OVERLAP (not containment)', () => {
    const prefs = resolveMemoryPreferences({
      hiddenDateRanges: [{ from: '2024-06-10', to: '2024-06-20' }],
    });

    it.each([
      ['fully inside', '2024-06-12', '2024-06-15', true],
      ['straddling the start', '2024-06-01', '2024-06-11', true],
      ['straddling the end', '2024-06-19', '2024-07-05', true],
      ['fully containing', '2024-01-01', '2024-12-31', true],
      ['touching the first day', '2024-06-10T00:00:00Z', '2024-06-10T00:00:00Z', true],
      ['touching the last day', '2024-06-20T23:59:59Z', '2024-06-20T23:59:59Z', true],
      ['entirely before', '2024-05-01', '2024-06-09T23:00:00Z', false],
      ['entirely after', '2024-06-21T00:00:01Z', '2024-07-01', false],
    ])('%s → %s', (_label, start, end, expected) => {
      expect(isMemoryHiddenByPreferences(memory(start, end), prefs)).toBe(expected);
    });
  });

  it('hides when ANY of several ranges overlaps', () => {
    const prefs = resolveMemoryPreferences({
      hiddenDateRanges: [
        { from: '2020-01-01', to: '2020-01-05' },
        { from: '2024-06-10', to: '2024-06-20' },
      ],
    });
    expect(isMemoryHiddenByPreferences(memory('2024-06-15', '2024-06-16'), prefs)).toBe(true);
    expect(isMemoryHiddenByPreferences(memory('2022-01-01', '2022-01-02'), prefs)).toBe(false);
  });
});
