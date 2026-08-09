/**
 * Unit tests for the deterministic memory title templates (issue #303).
 *
 * These are the permanent floor of the feature — on a deployment with no AI
 * provider configured they are the ONLY titles that ever render — so all seven
 * types are covered here, including the two edges the issue calls out
 * explicitly: pluralization, and a Person row with a NULL name.
 */

import {
  SEASON_LABELS,
  formatLongDate,
  formatMonthYear,
  onThisDayTitle,
  personHighlightsTitle,
  personOverYearsTitle,
  pluralize,
  seasonForMonth,
  seasonalTitle,
  themeTitle,
  titleCaseTag,
  tripTitle,
  yearInReviewTitle,
} from './memory-title-templates';

describe('memory title templates', () => {
  describe('helpers', () => {
    it('pluralizes on 1 vs. n', () => {
      expect(pluralize(1, 'year')).toBe('1 year');
      expect(pluralize(6, 'year')).toBe('6 years');
      expect(pluralize(0, 'year')).toBe('0 years');
    });

    it('formats dates in UTC regardless of the host zone', () => {
      // 2019-03-12T23:30Z is still March 12 in UTC but March 13 in, say,
      // Asia/Tokyo — the explicit timeZone pin is what keeps a title stable
      // across deployments.
      expect(formatLongDate(new Date('2019-03-12T23:30:00Z'))).toBe('March 12, 2019');
      expect(formatMonthYear(new Date('2023-03-01T00:00:00Z'))).toBe('March 2023');
    });

    it('title-cases multi-word tags without touching inner characters', () => {
      expect(titleCaseTag('golden sunsets')).toBe('Golden Sunsets');
      expect(titleCaseTag('beach')).toBe('Beach');
      expect(titleCaseTag('  spaced   out ')).toBe('Spaced Out');
    });

    it('maps months to northern-hemisphere meteorological seasons', () => {
      expect(seasonForMonth(12)).toBe('winter');
      expect(seasonForMonth(1)).toBe('winter');
      expect(seasonForMonth(2)).toBe('winter');
      expect(seasonForMonth(3)).toBe('spring');
      expect(seasonForMonth(5)).toBe('spring');
      expect(seasonForMonth(6)).toBe('summer');
      expect(seasonForMonth(8)).toBe('summer');
      expect(seasonForMonth(9)).toBe('fall');
      expect(seasonForMonth(11)).toBe('fall');
      expect(Object.keys(SEASON_LABELS)).toHaveLength(4);
    });
  });

  it('on_this_day', () => {
    expect(onThisDayTitle(6, new Date('2019-03-12T10:00:00Z'))).toEqual({
      title: 'On this day — 6 years ago',
      subtitle: 'March 12, 2019',
    });
    // The singular case is the one a naive `${n} years ago` gets wrong.
    expect(onThisDayTitle(1, new Date('2024-12-25T00:00:00Z'))).toEqual({
      title: 'On this day — 1 year ago',
      subtitle: 'December 25, 2024',
    });
  });

  describe('trip', () => {
    it('uses a single month when the trip does not span one', () => {
      expect(
        tripTitle('Guanacaste', new Date('2023-03-12T00:00:00Z'), new Date('2023-03-19T00:00:00Z')),
      ).toEqual({ title: 'Trip to Guanacaste', subtitle: 'March 2023' });
    });

    it('uses a month range within one year', () => {
      expect(
        tripTitle('Kyoto', new Date('2023-03-28T00:00:00Z'), new Date('2023-04-04T00:00:00Z')),
      ).toEqual({ title: 'Trip to Kyoto', subtitle: 'March–April 2023' });
    });

    it('repeats the year for a trip spanning New Year', () => {
      expect(
        tripTitle('Bariloche', new Date('2023-12-28T00:00:00Z'), new Date('2024-01-04T00:00:00Z')),
      ).toEqual({ title: 'Trip to Bariloche', subtitle: 'December 2023–January 2024' });
    });
  });

  describe('person_highlights', () => {
    it('names the person and the year', () => {
      expect(personHighlightsTitle('Abuela', 2025)).toEqual({
        title: 'Best of Abuela',
        subtitle: '2025',
      });
    });

    it('falls back for a NULL-named person rather than rendering an empty name', () => {
      expect(personHighlightsTitle(null, 2025).title).toBe('Best moments together');
      expect(personHighlightsTitle(undefined, 2025).title).toBe('Best moments together');
      expect(personHighlightsTitle('   ', 2025).title).toBe('Best moments together');
    });

    it('omits the subtitle for an all-time collection', () => {
      expect(personHighlightsTitle('Abuela', null).subtitle).toBeNull();
    });
  });

  describe('person_over_years', () => {
    it('renders the year span', () => {
      expect(personOverYearsTitle('Camila', 2016, 2025)).toEqual({
        title: 'Camila through the years',
        subtitle: '2016–2025',
      });
    });

    it('collapses a single-year span', () => {
      expect(personOverYearsTitle('Camila', 2025, 2025).subtitle).toBe('2025');
    });

    it('falls back for a NULL-named person', () => {
      expect(personOverYearsTitle(null, 2016, 2025).title).toBe('Through the years');
    });
  });

  it('theme', () => {
    expect(themeTitle('golden sunsets', 14)).toEqual({
      title: 'Golden Sunsets',
      subtitle: '14 favorite moments',
    });
    expect(themeTitle('pets', 1).subtitle).toBe('1 favorite moment');
  });

  it('seasonal', () => {
    expect(seasonalTitle('summer', 2025)).toEqual({ title: 'Summer 2025', subtitle: null });
    expect(seasonalTitle('winter', 2024).title).toBe('Winter 2024');
  });

  it('year_in_review', () => {
    expect(yearInReviewTitle(2025, 42)).toEqual({
      title: 'Your 2025 in review',
      subtitle: '42 highlights from the year',
    });
    expect(yearInReviewTitle(2025, 1).subtitle).toBe('1 highlight from the year');
  });
});
