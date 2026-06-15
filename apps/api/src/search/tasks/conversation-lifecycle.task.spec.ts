/**
 * Unit tests for computeLifecycleActions (pure function — no NestJS module needed).
 */
import { computeLifecycleActions } from './conversation-lifecycle.task';

// Fixed reference point for all tests
const NOW = new Date('2024-06-01T00:00:00.000Z');
const ARCHIVE_AFTER = 30;
const DELETE_AFTER = 30;

type ConvInput = Parameters<typeof computeLifecycleActions>[3][number];

function makeConv(
  overrides: Partial<{
    id: string;
    favorite: boolean;
    updatedAt: Date;
    archivedAt: Date | null;
    deletedAt: Date | null;
  }> = {},
): ConvInput {
  return {
    id: 'conv-1',
    favorite: false,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function daysBeforeNow(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe('computeLifecycleActions', () => {
  describe('archiving logic', () => {
    it('archives a stale active conversation (updatedAt 31 days ago)', () => {
      const conv = makeConv({
        id: 'stale-active',
        updatedAt: daysBeforeNow(31),
        archivedAt: null,
        favorite: false,
      });
      const { toArchive, toDelete } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, [conv]);
      expect(toArchive).toContain('stale-active');
      expect(toDelete).not.toContain('stale-active');
    });

    it('does NOT archive a recently active conversation (updatedAt 5 days ago)', () => {
      const conv = makeConv({
        id: 'recent-active',
        updatedAt: daysBeforeNow(5),
        archivedAt: null,
        favorite: false,
      });
      const { toArchive, toDelete } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, [conv]);
      expect(toArchive).not.toContain('recent-active');
      expect(toDelete).not.toContain('recent-active');
    });

    it('archives conversation updated exactly at the cutoff boundary (30 days = not yet stale)', () => {
      // updatedAt = exactly 30 days ago → NOT stale (cutoff requires <, not <=)
      const conv = makeConv({
        id: 'at-boundary',
        updatedAt: daysBeforeNow(30),
        archivedAt: null,
        favorite: false,
      });
      const { toArchive } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, [conv]);
      // Exactly at cutoff — updatedAt < archiveCutoff is false when equal, so NOT archived
      expect(toArchive).not.toContain('at-boundary');
    });

    it('archives conversation updated 30 days and 1 millisecond ago (just past boundary)', () => {
      const cutoff = daysBeforeNow(30);
      const justPast = new Date(cutoff.getTime() - 1); // 1ms before cutoff
      const conv = makeConv({ id: 'just-past', updatedAt: justPast, archivedAt: null });
      const { toArchive } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, [conv]);
      expect(toArchive).toContain('just-past');
    });
  });

  describe('deletion logic', () => {
    it('soft-deletes an archived conversation past the delete window (archivedAt 31 days ago)', () => {
      const conv = makeConv({
        id: 'stale-archived',
        updatedAt: daysBeforeNow(90),
        archivedAt: daysBeforeNow(31),
        favorite: false,
      });
      const { toDelete, toArchive } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, [conv]);
      expect(toDelete).toContain('stale-archived');
      expect(toArchive).not.toContain('stale-archived');
    });

    it('does NOT delete a recently archived conversation (archivedAt 5 days ago)', () => {
      const conv = makeConv({
        id: 'recent-archived',
        updatedAt: daysBeforeNow(50),
        archivedAt: daysBeforeNow(5),
        favorite: false,
      });
      const { toDelete, toArchive } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, [conv]);
      expect(toDelete).not.toContain('recent-archived');
      expect(toArchive).not.toContain('recent-archived');
    });
  });

  describe('favorite exemption', () => {
    it('does NOT archive a favorited stale conversation', () => {
      const conv = makeConv({
        id: 'fav-stale',
        updatedAt: daysBeforeNow(60),
        archivedAt: null,
        favorite: true,
      });
      const { toArchive, toDelete } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, [conv]);
      expect(toArchive).not.toContain('fav-stale');
      expect(toDelete).not.toContain('fav-stale');
    });

    it('does NOT delete a favorited archived conversation', () => {
      const conv = makeConv({
        id: 'fav-archived',
        updatedAt: daysBeforeNow(90),
        archivedAt: daysBeforeNow(60),
        favorite: true,
      });
      const { toArchive, toDelete } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, [conv]);
      expect(toArchive).not.toContain('fav-archived');
      expect(toDelete).not.toContain('fav-archived');
    });
  });

  describe('already-deleted conversations', () => {
    it('skips conversations with non-null deletedAt', () => {
      const conv = makeConv({
        id: 'already-deleted',
        updatedAt: daysBeforeNow(90),
        archivedAt: daysBeforeNow(60),
        deletedAt: NOW, // already soft-deleted
        favorite: false,
      });
      const { toArchive, toDelete } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, [conv]);
      expect(toArchive).not.toContain('already-deleted');
      expect(toDelete).not.toContain('already-deleted');
    });

    it('skips past-deleted conversations regardless of other fields', () => {
      const conv = makeConv({
        id: 'past-deleted',
        updatedAt: daysBeforeNow(100),
        archivedAt: null,
        deletedAt: daysBeforeNow(5),
        favorite: false,
      });
      const { toArchive, toDelete } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, [conv]);
      expect(toArchive).not.toContain('past-deleted');
      expect(toDelete).not.toContain('past-deleted');
    });
  });

  describe('empty input', () => {
    it('returns empty arrays for empty conversation list', () => {
      const { toArchive, toDelete } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, []);
      expect(toArchive).toEqual([]);
      expect(toDelete).toEqual([]);
    });
  });

  describe('multiple conversations, mixed states', () => {
    it('correctly categorises an array of 4 mixed-state conversations', () => {
      const conversations = [
        makeConv({ id: 'archive-me', updatedAt: daysBeforeNow(45), archivedAt: null, favorite: false }),
        makeConv({ id: 'delete-me', updatedAt: daysBeforeNow(90), archivedAt: daysBeforeNow(45), favorite: false }),
        makeConv({ id: 'keep-me-recent', updatedAt: daysBeforeNow(2), archivedAt: null, favorite: false }),
        makeConv({ id: 'keep-me-fav', updatedAt: daysBeforeNow(60), archivedAt: null, favorite: true }),
      ];

      const { toArchive, toDelete } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, conversations);

      expect(toArchive).toEqual(['archive-me']);
      expect(toDelete).toEqual(['delete-me']);
    });

    it('handles already-deleted entries within a mixed array', () => {
      const conversations = [
        makeConv({ id: 'archive-candidate', updatedAt: daysBeforeNow(31), archivedAt: null, favorite: false }),
        makeConv({ id: 'already-gone', updatedAt: daysBeforeNow(90), archivedAt: daysBeforeNow(60), deletedAt: daysBeforeNow(1), favorite: false }),
      ];

      const { toArchive, toDelete } = computeLifecycleActions(NOW, ARCHIVE_AFTER, DELETE_AFTER, conversations);

      expect(toArchive).toContain('archive-candidate');
      expect(toArchive).not.toContain('already-gone');
      expect(toDelete).not.toContain('already-gone');
    });
  });

  describe('configurable window sizes', () => {
    it('respects a custom archiveAfterDays of 7', () => {
      const conv = makeConv({ id: 'week-stale', updatedAt: daysBeforeNow(8), archivedAt: null, favorite: false });
      const { toArchive } = computeLifecycleActions(NOW, 7, 30, [conv]);
      expect(toArchive).toContain('week-stale');
    });

    it('does NOT archive when within custom window', () => {
      const conv = makeConv({ id: 'week-fresh', updatedAt: daysBeforeNow(5), archivedAt: null, favorite: false });
      const { toArchive } = computeLifecycleActions(NOW, 7, 30, [conv]);
      expect(toArchive).not.toContain('week-fresh');
    });

    it('respects a custom deleteAfterArchiveDays of 7', () => {
      const conv = makeConv({
        id: 'week-archived',
        updatedAt: daysBeforeNow(90),
        archivedAt: daysBeforeNow(8),
        favorite: false,
      });
      const { toDelete } = computeLifecycleActions(NOW, 30, 7, [conv]);
      expect(toDelete).toContain('week-archived');
    });
  });
});
