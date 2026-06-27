/**
 * Unit tests for US_STATE_CODES and resolveUsState.
 *
 * Covers:
 *  - Entry count (56: 50 states + DC + 5 territories)
 *  - Presence of DC, PR, GU, VI, AS, MP
 *  - Case-insensitive resolution
 *  - Whitespace trimming
 *  - Unknown code → undefined
 *  - Missing input → undefined
 */

import { US_STATE_CODES, resolveUsState } from './us-state-codes';

// ---------------------------------------------------------------------------
// US_STATE_CODES constant
// ---------------------------------------------------------------------------

describe('US_STATE_CODES', () => {
  it('has exactly 56 entries (50 states + DC + 5 territories)', () => {
    expect(Object.keys(US_STATE_CODES).length).toBe(56);
  });

  it('maps DC to "District of Columbia"', () => {
    expect(US_STATE_CODES['DC']).toBe('District of Columbia');
  });

  it('includes all five US territories (PR, GU, VI, AS, MP)', () => {
    expect(US_STATE_CODES['PR']).toBe('Puerto Rico');
    expect(US_STATE_CODES['VI']).toBe('U.S. Virgin Islands');
    expect(US_STATE_CODES['GU']).toBe('Guam');
    expect(US_STATE_CODES['AS']).toBe('American Samoa');
    expect(US_STATE_CODES['MP']).toBe('Northern Mariana Islands');
  });
});

// ---------------------------------------------------------------------------
// resolveUsState function
// ---------------------------------------------------------------------------

describe('resolveUsState', () => {
  it("resolves 'CA' to 'California'", () => {
    expect(resolveUsState('CA')).toBe('California');
  });

  it("resolves lowercase 'tx' to 'Texas' (case-insensitive)", () => {
    expect(resolveUsState('tx')).toBe('Texas');
  });

  it("resolves ' ny ' (with surrounding spaces) to 'New York' (trims whitespace)", () => {
    expect(resolveUsState(' ny ')).toBe('New York');
  });

  it("returns undefined for unrecognised code 'ZZ'", () => {
    expect(resolveUsState('ZZ')).toBeUndefined();
  });

  it('returns undefined when called with undefined', () => {
    expect(resolveUsState(undefined)).toBeUndefined();
  });
});
