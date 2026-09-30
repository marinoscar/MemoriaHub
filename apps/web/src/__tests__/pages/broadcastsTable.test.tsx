/**
 * The Broadcasts DataTable contract — epic #481, issue #488.
 */
import { describe, it, expect } from 'vitest';
import { makeBroadcast } from '../fixtures/broadcasts';
import {
  STATUS_COLUMN_ID,
  asBroadcastStatus,
  buildBroadcastColumns,
  cancelDescription,
  deleteDescription,
  formatProgress,
  progressPercent,
  readIsFilter,
  resumeDescription,
  userLabel,
} from '../../pages/Admin/broadcastsTable';

describe('broadcastsTable', () => {
  const columns = buildBroadcastColumns();

  it('declares no sortable column (the API offers no sortBy)', () => {
    expect(columns.some((column) => column.sortable)).toBe(false);
  });

  it('makes the title scalar row-unique with the short id', () => {
    const title = columns.find((column) => column.id === 'title')!;
    expect(title.value!(makeBroadcast())).toBe('Planned maintenance (11111111)');
    expect(title.hideable).toBe(false);
  });

  it('filters status with the "is" operator over every status', () => {
    const status = columns.find((column) => column.id === STATUS_COLUMN_ID)!;
    expect(status.filterable).toEqual(['is']);
    expect(status.enumValues).toHaveLength(6);
  });

  it('never prints 0 / 0 before the audience is counted', () => {
    expect(formatProgress(makeBroadcast({ recipientCount: null, processedCount: 0 }))).toBe('0 / —');
    expect(progressPercent(makeBroadcast({ recipientCount: null }))).toBeNull();
    expect(progressPercent(makeBroadcast({ recipientCount: 4, processedCount: 1 }))).toBe(25);
    expect(progressPercent(makeBroadcast({ recipientCount: 0, processedCount: 0 }))).toBe(100);
  });

  it('reads "Immediately" for an unscheduled send and names importance in words', () => {
    const scheduled = columns.find((column) => column.id === 'scheduledFor')!;
    const importance = columns.find((column) => column.id === 'importance')!;
    expect(scheduled.value!(makeBroadcast())).toBe('Immediately');
    expect(importance.value!(makeBroadcast({ critical: true }))).toBe('Cannot be muted');
  });

  it('renders users as names, never objects', () => {
    expect(userLabel(makeBroadcast().createdBy)).toBe('Ada (admin@example.com)');
    expect(userLabel({ id: 'x', email: 'e@x.co', displayName: null })).toBe('e@x.co');
    expect(userLabel(null)).toBe('—');
  });

  it('reads and narrows the status filter', () => {
    const filters = [{ columnId: STATUS_COLUMN_ID, operator: 'is' as const, value: 'failed' }];
    expect(readIsFilter(filters, STATUS_COLUMN_ID)).toBe('failed');
    expect(asBroadcastStatus('failed')).toBe('failed');
    expect(asBroadcastStatus('bogus')).toBeUndefined();
  });

  it('names the in-flight and duplicate bounds in the confirmations', () => {
    expect(cancelDescription(makeBroadcast({ status: 'sending' }))).toMatch(/next 25 recipients/);
    expect(cancelDescription(makeBroadcast({ status: 'scheduled' }))).toMatch(/will not be sent/);
    expect(cancelDescription(makeBroadcast({ status: 'failed', processedCount: 3 }))).toMatch(
      /stopped after 3 of 10/,
    );
    expect(resumeDescription(makeBroadcast({ status: 'failed' }))).toMatch(/25 recipients/);
    expect(deleteDescription(makeBroadcast())).toMatch(/NOT withdrawn/);
  });
});
