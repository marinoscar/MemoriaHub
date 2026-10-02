/** Diagnostic report ordering (issue #515): failures first, unknown statuses fall back to skip. */
import { describe, expect, it } from 'vitest';
import { sortedChecks } from '../../../components/settings/mediaSync/DiagnosticReportViewer';

describe('sortedChecks', () => {
  it('orders fail, warn, pass, skip and tolerates malformed entries', () => {
    const checks = sortedChecks({
      checks: [
        { id: 'network', label: 'Network', status: 'pass' },
        { id: 'battery', label: 'Battery', status: 'warn', remedy: 'Allow background use' },
        { id: 'mystery', status: 'exploded' },
        { id: 'permission', label: 'Photo access', status: 'fail', detail: 'Partial access' },
        'not an object',
      ],
    });
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['permission', 'fail'],
      ['battery', 'warn'],
      ['network', 'pass'],
      ['mystery', 'skip'],
      ['check-4', 'skip'],
    ]);
    expect(checks[0].detail).toBe('Partial access');
    expect(checks[1].remedy).toBe('Allow background use');
  });

  it('returns nothing for a report without checks', () => {
    expect(sortedChecks({ summary: 'ok' })).toEqual([]);
  });
});
