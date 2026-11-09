/** The wire rewrite of the legacy `circleId` (RETRO-I6, #588). */
import { afterEach, describe, expect, it } from 'vitest';
import {
  armOwnerScopeParams,
  disarmOwnerScopeParams,
  rewriteBody,
  rewriteEndpoint,
} from '../../services/ownerScopeParams';

const ME = 'personal-id';

describe('ownerScopeParams', () => {
  afterEach(() => disarmOwnerScopeParams());

  it('is a no-op until armed', () => {
    expect(rewriteEndpoint('/media?circleId=g1')).toBe('/media?circleId=g1');
    expect(rewriteBody('/albums', { circleId: 'g1' })).toEqual({ circleId: 'g1' });
  });

  it('turns the personal library into scope=me and a group into ownerGroupId', () => {
    armOwnerScopeParams(ME);
    expect(rewriteEndpoint(`/media?circleId=${ME}&page=1`)).toBe('/media?scope=me&page=1');
    expect(rewriteEndpoint('/media?page=1&circleId=g1')).toBe('/media?page=1&ownerGroupId=g1');
    expect(rewriteBody('/media/albums', { circleId: ME, name: 'Trip' })).toEqual({ scope: 'me', name: 'Trip' });
    expect(rewriteBody('/media/albums', { circleId: 'g1', name: 'Trip' })).toEqual({ ownerGroupId: 'g1', name: 'Trip' });
  });

  it('leaves a request with its own scope parameter, the platform routes and other bodies alone', () => {
    armOwnerScopeParams(ME);
    expect(rewriteEndpoint('/shares?scope=all&circleId=g1')).toBe('/shares?scope=all&circleId=g1');
    expect(rewriteEndpoint('/groups?circleId=g1')).toBe('/groups?circleId=g1');
    expect(rewriteEndpoint('/media/abc')).toBe('/media/abc');
    expect(rewriteBody('/grants', { circleId: 'g1' })).toEqual({ circleId: 'g1' });
    expect(rewriteBody('/media', [{ circleId: 'g1' }])).toEqual([{ circleId: 'g1' }]);
    expect(rewriteBody('/media', { ids: ['a'] })).toEqual({ ids: ['a'] });
  });
});
