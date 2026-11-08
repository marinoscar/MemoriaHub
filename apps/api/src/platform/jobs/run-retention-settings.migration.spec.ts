import { planRunRetentionCarryOver } from './run-retention-settings.migration';

describe('planRunRetentionCarryOver (RETRO-C7)', () => {
  it('carries both legacy windows into absent retention entries, enabled', () => {
    const stored = {
      workflows: { runHistoryRetentionDays: 45, previewTtlHours: 24 },
      reviewRuns: { runHistoryRetentionDays: 7 },
      retention: { notifications: { enabled: true, days: 30 } },
    };
    const { changes, next } = planRunRetentionCarryOver(stored);
    expect(changes.map((c) => [c.key, c.action, c.days])).toEqual([
      ['workflowRuns', 'write', 45],
      ['reviewRuns', 'write', 7],
    ]);
    expect(next['retention']).toEqual({
      notifications: { enabled: true, days: 30 },
      workflowRuns: { enabled: true, days: 45 },
      reviewRuns: { enabled: true, days: 7 },
    });
    // The old keys stay (RETRO-C11 removes them) and the input is not mutated.
    expect(next['workflows']).toEqual(stored.workflows);
    expect(stored.retention).toEqual({ notifications: { enabled: true, days: 30 } });
  });

  it('is idempotent: a second pass over its own output keeps everything', () => {
    const first = planRunRetentionCarryOver({ workflows: { runHistoryRetentionDays: 45 } }).next;
    const second = planRunRetentionCarryOver(first);
    expect(second.changes.map((c) => c.action)).toEqual(['keep', 'skip']);
    expect(second.next).toEqual(first);
  });

  it('never overwrites a retention entry an operator already saved', () => {
    const { changes, next } = planRunRetentionCarryOver({
      workflows: { runHistoryRetentionDays: 45 },
      retention: { workflowRuns: { enabled: false, days: 90 } },
    });
    expect(changes[0]).toMatchObject({ action: 'keep', days: 90 });
    expect(next['retention']).toEqual({ workflowRuns: { enabled: false, days: 90 } });
  });

  it('skips a missing or out-of-range legacy value', () => {
    const { changes, next } = planRunRetentionCarryOver({ reviewRuns: { runHistoryRetentionDays: 9999 } });
    expect(changes.map((c) => c.action)).toEqual(['skip', 'skip']);
    expect(next['retention']).toBeUndefined();
    expect(planRunRetentionCarryOver(null).changes.map((c) => c.action)).toEqual(['skip', 'skip']);
  });
});
