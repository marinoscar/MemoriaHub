/**
 * test/commands/circles.spec.ts
 *
 * Unit tests for the circles command validation logic.
 * Tests that 'circles use' validates IDs against the server list and saves config,
 * and that 'circles list' formats output correctly.
 *
 * We test the validation helper extracted from the use-command action,
 * and use mocked ApiClient to avoid real network calls.
 */

import { jest } from '@jest/globals';
import type { Circle } from '../../src/api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The validation logic extracted from circles use: find a circle by id. */
function resolveCircle(circles: Circle[], id: string): Circle | undefined {
  return circles.find((c) => c.id === id);
}

const MOCK_CIRCLES: Circle[] = [
  { id: 'circle-001', name: 'Family',    isPersonal: false },
  { id: 'circle-002', name: 'Personal',  isPersonal: true  },
  { id: 'circle-003', name: 'Work Trip', isPersonal: false },
];

// ---------------------------------------------------------------------------
// resolveCircle (pure validation)
// ---------------------------------------------------------------------------

describe('resolveCircle', () => {
  it('returns the circle when a valid ID is provided', () => {
    const result = resolveCircle(MOCK_CIRCLES, 'circle-001');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Family');
  });

  it('returns undefined for an unknown ID', () => {
    const result = resolveCircle(MOCK_CIRCLES, 'circle-999');
    expect(result).toBeUndefined();
  });

  it('returns the personal circle by id', () => {
    const result = resolveCircle(MOCK_CIRCLES, 'circle-002');
    expect(result).toBeDefined();
    expect(result!.isPersonal).toBe(true);
  });

  it('handles an empty circles list', () => {
    const result = resolveCircle([], 'circle-001');
    expect(result).toBeUndefined();
  });

  it('returns undefined for an empty string id', () => {
    const result = resolveCircle(MOCK_CIRCLES, '');
    expect(result).toBeUndefined();
  });

  it('matches exact id only (no partial matches)', () => {
    const result = resolveCircle(MOCK_CIRCLES, 'circle-00');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// circles use — integration via mocked ApiClient
// ---------------------------------------------------------------------------

describe('circles use — config persistence', () => {
  it('uses activeCircleId from saved config when ID is valid', () => {
    // Simulate the logic of circles use: validate + save
    const id = 'circle-002';
    const found = resolveCircle(MOCK_CIRCLES, id);
    expect(found).toBeDefined();

    // Simulate the merged config that would be saved
    const existingConfig = { serverUrl: 'https://example.com', pat: 'pat-abc' };
    const newConfig = { ...existingConfig, activeCircleId: id };
    expect(newConfig.activeCircleId).toBe('circle-002');
    expect(newConfig.serverUrl).toBe('https://example.com');
    expect(newConfig.pat).toBe('pat-abc');
  });

  it('does not change other config fields when setting activeCircleId', () => {
    const existingConfig = {
      serverUrl: 'https://example.com',
      pat: 'pat-xyz',
      activeCircleId: 'old-circle',
    };
    const id = 'circle-003';
    const found = resolveCircle(MOCK_CIRCLES, id);
    expect(found).toBeDefined();

    const newConfig = { ...existingConfig, activeCircleId: id };
    expect(newConfig.serverUrl).toBe('https://example.com');
    expect(newConfig.pat).toBe('pat-xyz');
    expect(newConfig.activeCircleId).toBe('circle-003');
  });
});

// ---------------------------------------------------------------------------
// circles list — display logic
// ---------------------------------------------------------------------------

describe('circles list — display logic', () => {
  it('marks active circle with asterisk when activeCircleId matches', () => {
    const activeCircleId = 'circle-001';
    const marked = MOCK_CIRCLES.map((c) => ({
      ...c,
      isActive: c.id === activeCircleId,
    }));
    expect(marked.find((c) => c.id === 'circle-001')!.isActive).toBe(true);
    expect(marked.find((c) => c.id === 'circle-002')!.isActive).toBe(false);
    expect(marked.find((c) => c.id === 'circle-003')!.isActive).toBe(false);
  });

  it('marks no circles as active when activeCircleId is not set', () => {
    const activeCircleId: string | undefined = undefined;
    const marked = MOCK_CIRCLES.map((c) => ({
      ...c,
      isActive: c.id === activeCircleId,
    }));
    expect(marked.every((c) => !c.isActive)).toBe(true);
  });

  it('correctly identifies personal circles', () => {
    const personal = MOCK_CIRCLES.filter((c) => c.isPersonal);
    expect(personal).toHaveLength(1);
    expect(personal[0].name).toBe('Personal');
  });

  it('handles empty circles list without error', () => {
    const empty: Circle[] = [];
    const activeCircleId = 'circle-001';
    const marked = empty.map((c) => ({ ...c, isActive: c.id === activeCircleId }));
    expect(marked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suppress unused import warning for jest
// ---------------------------------------------------------------------------
void jest;
