/**
 * The null-confidence exclusion of the real duplicate review-run strategy (issue #190).
 *
 * The shared engine's evaluate handler moved into `@marinoscar/memoriahub-api/review-runs` (RETRO-J9, #622); its
 * spec drives a stub strategy. This strategy stays in the web app (the burst one moved with the burst slice,
 * RETRO-J10, #624), so the assertion that it builds a
 * `confidence: { not: null, ... }` filter in BOTH the resolve and the dismiss direction stays here, against the
 * real strategy rather than a stub: the exclusion is strategy-owned logic, not handler logic.
 */

import { ReviewRunAction, ReviewRunSubject } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { DuplicateGroupReviewStrategy } from './duplicate-group.strategy';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const RUN_ID = randomUUID();
const CIRCLE_ID = randomUUID();

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    circleId: CIRCLE_ID,
    subjectType: ReviewRunSubject.burst_group,
    action: ReviewRunAction.resolve_archive,
    threshold: 60,
    status: 'evaluating',
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: randomUUID(),
    ...overrides,
  };
}

describe('review-run strategies: null-confidence exclusion', () => {

  describe('null-confidence exclusion (real DuplicateGroupReviewStrategy)', () => {
    let strategyPrisma: MockPrismaService;

    beforeEach(() => {
      strategyPrisma = createMockPrismaService();
      (strategyPrisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('DuplicateGroupReviewStrategy: a resolve run filters confidence { not: null, gte: floor }', async () => {
      const strategy = new DuplicateGroupReviewStrategy(
        strategyPrisma as unknown as PrismaService,
        {} as any,
        { register: jest.fn() } as never,
      );
      const run = makeRun({
        subjectType: ReviewRunSubject.duplicate_group,
        action: ReviewRunAction.resolve_trash,
        threshold: 75,
      });

      await strategy.evaluatePage(run as any, null, 1000);

      const where = (strategyPrisma.duplicateGroup.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.confidence).toEqual({ not: null, gte: 0.75 });
    });

    it('DuplicateGroupReviewStrategy: a dismiss run filters confidence { not: null, lt: floor }', async () => {
      const strategy = new DuplicateGroupReviewStrategy(
        strategyPrisma as unknown as PrismaService,
        {} as any,
        { register: jest.fn() } as never,
      );
      const run = makeRun({
        subjectType: ReviewRunSubject.duplicate_group,
        action: ReviewRunAction.dismiss,
        threshold: 75,
      });

      await strategy.evaluatePage(run as any, null, 1000);

      const where = (strategyPrisma.duplicateGroup.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.confidence).toEqual({ not: null, lt: 0.75 });
    });
  });
});
