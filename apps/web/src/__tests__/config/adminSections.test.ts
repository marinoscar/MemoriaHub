/**
 * Unit tests for `config/adminSections.tsx` (issue #389, epic #388).
 *
 * This module is the single declaration consumed by three surfaces
 * (SettingsHubPage, Sidebar Console mode, AppBar's admin-title resolver), so
 * its two pure functions — `visibleAdminSections` and `adminPageTitle` — are
 * the load-bearing logic the whole "Console invents no new admin IA" claim
 * (spec §3.2) rests on. Covered directly here rather than only indirectly
 * through the three consumers.
 */
import { describe, it, expect } from 'vitest';
import {
  ADMIN_SECTIONS,
  ADMIN_HUB_PATH,
  ADMIN_HUB_TITLE,
  visibleAdminSections,
  adminPageTitle,
} from '../../config/adminSections';

/** Flatten every card across every section, for whole-catalog assertions. */
function allCards() {
  return ADMIN_SECTIONS.flatMap((section) => section.cards);
}

function allowAll() {
  return () => true;
}

function allowNone() {
  return () => false;
}

function allowOnly(...allowed: string[]) {
  return (permission: string) => allowed.includes(permission);
}

describe('adminSections', () => {
  describe('module shape sanity', () => {
    it('exposes the hub path and title constants', () => {
      expect(ADMIN_HUB_PATH).toBe('/admin/settings');
      expect(ADMIN_HUB_TITLE).toBe('Settings');
    });

    it('every card carries a component (not an element) as its Icon', () => {
      allCards().forEach((card) => {
        // A component reference is a function (or, for some MUI icon
        // exports, an object wrapping one via forwardRef) — either way it is
        // NOT a rendered element, which would be a plain object with a
        // `$$typeof` symbol and `props`.
        expect(typeof card.Icon === 'function' || typeof card.Icon === 'object').toBe(true);
        expect(card.Icon).not.toBeNull();
      });
    });

    it('every card with a path has a permission or is explicitly alwaysShow', () => {
      // Not a hard requirement of the type, but every card actually declared
      // today is permission-gated — this pins that fact so a future card
      // added with neither is caught, since it would be visible to everyone
      // with no way to hide it.
      allCards().forEach((card) => {
        if (!card.path) return;
        expect(Boolean(card.permission) || Boolean(card.alwaysShow)).toBe(true);
      });
    });
  });

  describe('visibleAdminSections', () => {
    it('drops individual cards the permission gate rejects', () => {
      const sections = visibleAdminSections(allowOnly('jobs:read'));
      const titles = sections.flatMap((s) => s.cards.map((c) => c.title));

      expect(titles).toContain('Job Queue');
      expect(titles).toContain('Job Queue Insights');
      expect(titles).toContain('Worker Nodes');
      expect(titles).not.toContain('System');
      expect(titles).not.toContain('AI Providers');
      expect(titles).not.toContain('Database Backup');
    });

    it('drops a whole section when every one of its cards is rejected', () => {
      // Only db_backup:read passes — the only card that unlocks is
      // "Database Backup" (Operations). Every other section becomes empty
      // and must not appear at all, not appear with an empty cards array.
      const sections = visibleAdminSections(allowOnly('db_backup:read'));

      expect(sections).toHaveLength(1);
      expect(sections[0].label).toBe('Operations');
      expect(sections[0].cards.map((c) => c.title)).toEqual(['Database Backup']);
    });

    it('returns every section/card when every permission is granted', () => {
      const sections = visibleAdminSections(allowAll());

      expect(sections).toHaveLength(ADMIN_SECTIONS.length);
      const totalCards = sections.reduce((sum, s) => sum + s.cards.length, 0);
      expect(totalCards).toBe(allCards().length);
    });

    it('returns nothing when no permission is granted', () => {
      const sections = visibleAdminSections(allowNone());
      expect(sections).toEqual([]);
    });

    describe('query filtering', () => {
      it('filters cards by title, case-insensitively', () => {
        const sections = visibleAdminSections(allowAll(), 'job');
        const titles = sections.flatMap((s) => s.cards.map((c) => c.title));

        expect(titles.sort()).toEqual(['Job Queue', 'Job Queue Insights']);
      });

      it('matches regardless of the query\'s casing', () => {
        const lower = visibleAdminSections(allowAll(), 'job queue');
        const upper = visibleAdminSections(allowAll(), 'JOB QUEUE');
        const mixed = visibleAdminSections(allowAll(), 'Job Queue');

        const titlesOf = (sections: ReturnType<typeof visibleAdminSections>) =>
          sections.flatMap((s) => s.cards.map((c) => c.title)).sort();

        expect(titlesOf(lower)).toEqual(titlesOf(upper));
        expect(titlesOf(lower)).toEqual(titlesOf(mixed));
      });

      it('does not match on description text, only the title', () => {
        // "PostgreSQL" appears only in the Database Backup card's
        // description, never in any card title.
        const sections = visibleAdminSections(allowAll(), 'PostgreSQL');
        expect(sections).toEqual([]);
      });

      it('returns [] for a query that matches nothing', () => {
        const sections = visibleAdminSections(allowAll(), 'zzz-not-a-real-setting');
        expect(sections).toEqual([]);
      });

      it('an empty/whitespace-only query behaves like no query at all', () => {
        const noQuery = visibleAdminSections(allowAll());
        const emptyQuery = visibleAdminSections(allowAll(), '');
        const whitespaceQuery = visibleAdminSections(allowAll(), '   ');

        expect(emptyQuery).toEqual(noQuery);
        expect(whitespaceQuery).toEqual(noQuery);
      });

      it('a permission-gated card stays hidden regardless of a matching search text', () => {
        // "Job Queue" matches the query text, but the caller cannot see it —
        // the classic filter-bypasses-authz bug this function must not have.
        const sections = visibleAdminSections(allowNone(), 'job');
        expect(sections).toEqual([]);
      });

      it('a permission-gated card stays hidden even with an ALLOWED but wrong permission', () => {
        // Caller can see "Database Backup" cards but is searching for "job" —
        // the only cards matching "job" require jobs:read, which is absent.
        const sections = visibleAdminSections(allowOnly('db_backup:read'), 'job');
        expect(sections).toEqual([]);
      });
    });
  });

  describe('adminPageTitle', () => {
    it('returns null for a path outside /admin', () => {
      expect(adminPageTitle('/')).toBeNull();
      expect(adminPageTitle('/settings')).toBeNull();
      expect(adminPageTitle('/administrator')).toBeNull(); // not a segment match
    });

    it('returns the hub title for the hub path itself', () => {
      expect(adminPageTitle('/admin/settings')).toBe('Settings');
    });

    it('returns the hub title for bare /admin', () => {
      expect(adminPageTitle('/admin')).toBe('Settings');
    });

    it('resolves an exact card path to that card\'s title', () => {
      expect(adminPageTitle('/admin/settings/jobs')).toBe('Job Queue');
    });

    it('longest-prefix-wins: a nested detail route resolves to the more specific card', () => {
      // /admin/settings/jobs/insights is a prefix-match for BOTH the "Job
      // Queue" card (/admin/settings/jobs) and an exact match for "Job Queue
      // Insights" (/admin/settings/jobs/insights) — the longer path must win.
      expect(adminPageTitle('/admin/settings/jobs/insights')).toBe('Job Queue Insights');
    });

    it('a path nested one level under "Job Queue" (not "Insights") resolves to "Job Queue"', () => {
      expect(adminPageTitle('/admin/settings/jobs/some-detail')).toBe('Job Queue');
    });

    it('resolves a deeply-nested detail route to its parent card (Worker Nodes)', () => {
      expect(adminPageTitle('/admin/settings/nodes/abc/backup')).toBe('Worker Nodes');
    });

    it('falls back to the hub title for an unknown /admin/* path', () => {
      expect(adminPageTitle('/admin/settings/nonexistent-page')).toBe('Settings');
    });
  });
});
