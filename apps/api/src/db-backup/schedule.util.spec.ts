import { buildCronExpression, parseTimeOfDay } from './schedule.util';
import { isValidCron, nextCronDate } from '../workflows/util/cron.util';

describe('buildCronExpression (issue #342)', () => {
  // The exhaustive table the issue asks for: every frequency, boundary days,
  // and boundary times, each pinned to its exact expected cron string.
  const cases: Array<{
    label: string;
    frequency: 'daily' | 'weekly' | 'monthly';
    dayOfWeek: number;
    dayOfMonth: number;
    timeOfDay: string;
    expected: string;
  }> = [
    // --- daily -------------------------------------------------------------
    {
      label: 'daily @ 02:00 (the schema default)',
      frequency: 'daily',
      dayOfWeek: 0,
      dayOfMonth: 1,
      timeOfDay: '02:00',
      expected: '0 2 * * *',
    },
    {
      label: 'daily @ 00:00 (midnight)',
      frequency: 'daily',
      dayOfWeek: 3,
      dayOfMonth: 15,
      timeOfDay: '00:00',
      expected: '0 0 * * *',
    },
    {
      label: 'daily @ 23:59 (last minute of the day)',
      frequency: 'daily',
      dayOfWeek: 0,
      dayOfMonth: 1,
      timeOfDay: '23:59',
      expected: '59 23 * * *',
    },
    {
      label: 'daily @ 09:05 (leading zeros are stripped)',
      frequency: 'daily',
      dayOfWeek: 0,
      dayOfMonth: 1,
      timeOfDay: '09:05',
      expected: '5 9 * * *',
    },

    // --- weekly ------------------------------------------------------------
    {
      label: 'weekly Sunday @ 02:00',
      frequency: 'weekly',
      dayOfWeek: 0,
      dayOfMonth: 1,
      timeOfDay: '02:00',
      expected: '0 2 * * 0',
    },
    {
      label: 'weekly Monday @ 02:00 (the issue example)',
      frequency: 'weekly',
      dayOfWeek: 1,
      dayOfMonth: 1,
      timeOfDay: '02:00',
      expected: '0 2 * * 1',
    },
    {
      label: 'weekly Saturday @ 00:00',
      frequency: 'weekly',
      dayOfWeek: 6,
      dayOfMonth: 28,
      timeOfDay: '00:00',
      expected: '0 0 * * 6',
    },
    {
      label: 'weekly ignores dayOfMonth entirely',
      frequency: 'weekly',
      dayOfWeek: 4,
      dayOfMonth: 28,
      timeOfDay: '13:30',
      expected: '30 13 * * 4',
    },

    // --- monthly -----------------------------------------------------------
    {
      label: 'monthly day 1 @ 02:00 (the issue example)',
      frequency: 'monthly',
      dayOfWeek: 0,
      dayOfMonth: 1,
      timeOfDay: '02:00',
      expected: '0 2 1 * *',
    },
    {
      label: 'monthly day 28 @ 02:00 (the schema max)',
      frequency: 'monthly',
      dayOfWeek: 0,
      dayOfMonth: 28,
      timeOfDay: '02:00',
      expected: '0 2 28 * *',
    },
    {
      label: 'monthly day 28 @ 00:00 (max day, midnight)',
      frequency: 'monthly',
      dayOfWeek: 5,
      dayOfMonth: 28,
      timeOfDay: '00:00',
      expected: '0 0 28 * *',
    },
    {
      label: 'monthly ignores dayOfWeek entirely',
      frequency: 'monthly',
      dayOfWeek: 6,
      dayOfMonth: 15,
      timeOfDay: '17:45',
      expected: '45 17 15 * *',
    },
  ];

  it.each(cases)('$label → $expected', ({ frequency, dayOfWeek, dayOfMonth, timeOfDay, expected }) => {
    expect(buildCronExpression(frequency, dayOfWeek, dayOfMonth, timeOfDay)).toBe(expected);
  });

  it('produces expressions the shared isValidCron gate accepts', () => {
    for (const c of cases) {
      const expr = buildCronExpression(c.frequency, c.dayOfWeek, c.dayOfMonth, c.timeOfDay);
      expect(isValidCron(expr)).toBe(true);
    }
  });

  it('produces expressions the shared nextCronDate helper can evaluate', () => {
    const from = new Date('2026-03-10T12:00:00.000Z');
    for (const c of cases) {
      const expr = buildCronExpression(c.frequency, c.dayOfWeek, c.dayOfMonth, c.timeOfDay);
      const next = nextCronDate(expr, from, 'UTC');
      expect(next.getTime()).toBeGreaterThan(from.getTime());
    }
  });

  describe('defensive clamping (schema already validates; hand-edited JSON may not)', () => {
    it('clamps an out-of-range dayOfWeek', () => {
      expect(buildCronExpression('weekly', 9, 1, '02:00')).toBe('0 2 * * 6');
      expect(buildCronExpression('weekly', -3, 1, '02:00')).toBe('0 2 * * 0');
    });

    it('clamps dayOfMonth to 28 — days 29-31 do not exist in February', () => {
      expect(buildCronExpression('monthly', 0, 31, '02:00')).toBe('0 2 28 * *');
      expect(buildCronExpression('monthly', 0, 0, '02:00')).toBe('0 2 1 * *');
    });

    it('falls back to 02:00 on an unparseable timeOfDay', () => {
      expect(buildCronExpression('daily', 0, 1, 'not-a-time')).toBe('0 2 * * *');
      expect(buildCronExpression('daily', 0, 1, '24:00')).toBe('0 2 * * *');
      expect(buildCronExpression('daily', 0, 1, '02:60')).toBe('0 2 * * *');
      expect(buildCronExpression('daily', 0, 1, '')).toBe('0 2 * * *');
    });

    it('treats an unknown frequency as daily', () => {
      expect(buildCronExpression('hourly' as never, 0, 1, '02:00')).toBe('0 2 * * *');
    });
  });
});

describe('parseTimeOfDay', () => {
  it.each([
    ['00:00', 0, 0],
    ['02:00', 2, 0],
    ['09:05', 9, 5],
    ['23:59', 23, 59],
  ])('parses %s', (input, hour, minute) => {
    expect(parseTimeOfDay(input)).toEqual({ hour, minute });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseTimeOfDay('  07:30 ')).toEqual({ hour: 7, minute: 30 });
  });

  it('falls back to 02:00 on garbage', () => {
    expect(parseTimeOfDay('7:30')).toEqual({ hour: 2, minute: 0 });
    expect(parseTimeOfDay(undefined as never)).toEqual({ hour: 2, minute: 0 });
  });
});
