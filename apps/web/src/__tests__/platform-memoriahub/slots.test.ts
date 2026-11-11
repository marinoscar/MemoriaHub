/**
 * The web edition registers its slot components under the names the packaged media
 * slice looks them up by (RETRO-J11, #626). The names are spelled out in
 * `platform-memoriahub/slots.tsx` so that module loads no slice code; this test keeps
 * them equal to the package's constants.
 */
import { describe, expect, it } from 'vitest';
import * as names from '@marinoscar/memoriahub-web/media/headless';
import { SEARCH_PEOPLE_EXPLORE_SLOT } from '@marinoscar/memoriahub-web/search/headless';
import { WORKFLOW_PERSON_SELECT_SLOT } from '@marinoscar/memoriahub-web/workflows/headless';

import { APP_SLOT_NAMES, appMemoriahubSlots } from '../../platform-memoriahub/slots';

describe('app slots', () => {
  it('uses the names the package declares', () => {
    expect(APP_SLOT_NAMES).toEqual({
      lightbox: names.MEDIA_LIGHTBOX_SLOT,
      detailDrawer: names.MEDIA_DETAIL_DRAWER_SLOT,
      enhancementDrawer: names.MEDIA_ENHANCEMENT_DRAWER_SLOT,
      batchEnhanceDialog: names.BATCH_ENHANCE_DIALOG_SLOT,
      shareDialog: names.MEDIA_SHARE_DIALOG_SLOT,
      albumPeopleDialog: names.ALBUM_PEOPLE_DIALOG_SLOT,
      personMultiSelect: names.PERSON_MULTI_SELECT_SLOT,
      mergeLocationsDialog: names.MERGE_LOCATIONS_DIALOG_SLOT,
      searchPeopleExplore: SEARCH_PEOPLE_EXPLORE_SLOT,
      workflowPersonSelect: WORKFLOW_PERSON_SELECT_SLOT,
    });
  });

  it('registers a component for every name', () => {
    for (const name of Object.values(APP_SLOT_NAMES)) {
      expect(appMemoriahubSlots[name]).toBeTypeOf('function');
    }
  });
});
