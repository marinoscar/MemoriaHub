/**
 * RETRO-I6 (#588): the two requests that bypass `services/api.ts` (the agent
 * search stream and the media export download) send the owner scope as
 * `ownerGroupId` / `scope=me`, like every request through `api.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { armOwnerScopeParams, disarmOwnerScopeParams } from '../../services/ownerScopeParams';
import { streamAgent } from '../../services/searchAgentStream';
import { exportMedia } from '../../services/media';

const PERSONAL = 'personal-library-1';
const GROUP = 'group-alpha';

describe('owner scope on raw fetch requests', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    armOwnerScopeParams(PERSONAL);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    disarmOwnerScopeParams();
    fetchSpy.mockRestore();
  });

  it('streamAgent sends ownerGroupId for a group scope', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 200 }));
    await streamAgent({ circleId: GROUP, messages: [{ role: 'user', content: 'beach' }] }, {} as never).catch(() => undefined);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({ ownerGroupId: GROUP, messages: [{ role: 'user', content: 'beach' }] });
  });

  it('streamAgent sends scope=me for the personal library', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 200 }));
    await streamAgent({ circleId: PERSONAL, messages: [] }, {} as never).catch(() => undefined);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.scope).toBe('me');
    expect(body.circleId).toBeUndefined();
  });

  it('exportMedia rewrites circleId in the query string', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 500 }));
    await exportMedia('json', { circleId: GROUP }).catch(() => undefined);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url.startsWith('/api/media/export?')).toBe(true);
    expect(url).toContain(`ownerGroupId=${GROUP}`);
    expect(url).not.toContain('circleId=');
  });
});
