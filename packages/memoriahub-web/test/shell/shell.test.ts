import { describe, expect, it } from 'vitest';

import { MEDIA_SYNC_SETTINGS_PATH, memoriahubDestinationRoutes, memoriahubUserSettingsCards } from '../../src/shell/index.js';

describe('shell data', () => {
  it('declares the Media sync card behind the exact permission the API enforces', () => {
    expect(memoriahubUserSettingsCards.android).toHaveLength(1);
    const [card] = memoriahubUserSettingsCards.android;
    expect(card).toMatchObject({ title: 'Media sync', path: '/settings/media-sync', permission: 'media:read' });
    expect(card.path).toBe(MEDIA_SYNC_SETTINGS_PATH);
    expect(card.feature).toBeUndefined();
  });

  it('owns each route prefix once, on segment boundaries', () => {
    const all = [...memoriahubDestinationRoutes.photos, ...memoriahubDestinationRoutes.collections];
    expect(new Set(all).size).toBe(all.length);
    expect(memoriahubDestinationRoutes.photos).toEqual(['/', '/media']);
    expect(memoriahubDestinationRoutes.collections).toEqual(['/albums', '/places', '/map', '/archive', '/trash']);
  });
});
