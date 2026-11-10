/**
 * RETRO-I6 (#588): the CLI config's `activeOwnerScope`, with read-back
 * compatibility for `activeCircleId` (a pre-1.5.3 file) and the legacy field
 * still written beside it (a pre-1.5.3 CLI sharing the file).
 */
import { fromFileShape, ownerScopeFields, parseActiveOwnerScope, toFileShape } from '../src/config.js';

const GROUP = '33333333-3333-4333-8333-333333333333';
const PERSONAL = '44444444-4444-4444-8444-444444444444';
const base = { serverUrl: 'https://mh.example.test', token: 'pat_example' };

describe('activeOwnerScope in the CLI config', () => {
  it('reads a pre-1.5.3 file (activeCircleId only) exactly as before', () => {
    const cfg = fromFileShape({ ...base, activeCircleId: GROUP });
    expect(cfg.activeCircleId).toBe(GROUP);
    expect(cfg.activeOwnerScope).toBeUndefined();
  });

  it('a group scope names its scope id, even over a stale activeCircleId', () => {
    const cfg = fromFileShape({ ...base, activeOwnerScope: { kind: 'group', groupId: GROUP }, activeCircleId: PERSONAL });
    expect(cfg.activeOwnerScope).toEqual({ kind: 'group', groupId: GROUP });
    expect(cfg.activeCircleId).toBe(GROUP);
  });

  it("'me' keeps the resolved personal library id stored beside it", () => {
    const cfg = fromFileShape({ ...base, activeOwnerScope: { kind: 'me' }, activeCircleId: PERSONAL });
    expect(cfg.activeOwnerScope).toEqual({ kind: 'me' });
    expect(cfg.activeCircleId).toBe(PERSONAL);
  });

  it('ignores a malformed activeOwnerScope', () => {
    expect(parseActiveOwnerScope({ kind: 'group' })).toBeUndefined();
    expect(parseActiveOwnerScope('me')).toBeUndefined();
    const cfg = fromFileShape({ ...base, activeOwnerScope: { kind: 'circle' }, activeCircleId: GROUP });
    expect(cfg.activeOwnerScope).toBeUndefined();
    expect(cfg.activeCircleId).toBe(GROUP);
  });

  it('groups use writes both the new choice and the legacy id', () => {
    expect(ownerScopeFields({ id: PERSONAL, isPersonal: true })).toEqual({ activeOwnerScope: { kind: 'me' }, activeCircleId: PERSONAL });
    expect(ownerScopeFields({ id: GROUP, isPersonal: false })).toEqual({
      activeOwnerScope: { kind: 'group', groupId: GROUP },
      activeCircleId: GROUP,
    });
    const out = toFileShape({ serverUrl: base.serverUrl, pat: 'pat_example', ...ownerScopeFields({ id: GROUP }) });
    expect(out).toMatchObject({ activeOwnerScope: { kind: 'group', groupId: GROUP }, activeCircleId: GROUP });
  });
});
