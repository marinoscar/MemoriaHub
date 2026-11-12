/**
 * The components the packaged media slice asks its host for (`slots` of
 * `MemoriahubWebHost`): the platform's share dialog and inline link-share panel,
 * and the components of packaged slices that stay slots for good because those
 * slices import the media slice, so the media pages cannot import them: the
 * lightbox and detail drawer (the `viewer` slice), the two people pickers, the AI
 * enhancement drawer and batch dialog and the location-merge dialog (bound through
 * a small bridge). Each is lazy, so the page that needs it keeps it out of the main
 * chunk exactly as before. The link-share panel is the `viewer` slice's own slot.
 */
import { Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { MemoriahubWebSlots } from '@marinoscar/memoriahub-web/core/headless';
import type { LinkSharePanelSlotProps } from '@marinoscar/memoriahub-web/viewer/ui';
import type {
  AlbumPeopleDialogSlotProps,
  BatchEnhanceDialogSlotProps,
  MediaDetailDrawerSlotProps,
  MediaEnhancementDrawerSlotProps,
  MediaLightboxSlotProps,
  MediaShareDialogSlotProps,
  MergeLocationsDialogSlotProps,
  PersonMultiSelectSlotProps,
} from '@marinoscar/memoriahub-web/media/ui';

// The slot names are the package's (`@marinoscar/memoriahub-web/media/headless`
// `slot-names`); they are spelled out here so this module loads no slice code, and
// `__tests__/platform-memoriahub/slots.test.ts` asserts they match.
export const APP_SLOT_NAMES = {
  lightbox: 'media.lightbox',
  detailDrawer: 'media.detailDrawer',
  enhancementDrawer: 'media.enhancementDrawer',
  batchEnhanceDialog: 'media.batchEnhanceDialog',
  shareDialog: 'media.shareDialog',
  albumPeopleDialog: 'media.albumPeopleDialog',
  personMultiSelect: 'media.personMultiSelect',
  mergeLocationsDialog: 'media.mergeLocationsDialog',
  linkSharePanel: 'viewer.linkSharePanel',
} as const;

/** A lazy component behind a null-fallback Suspense, so a slot renders like the eager import did. */
function lazySlot<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  const Lazy = lazy(load);
  const Slot = (props: P): ReactNode => (
    <Suspense fallback={null}>
      <Lazy {...(props as P & object)} />
    </Suspense>
  );
  return Slot;
}

const MediaLightboxSlot = lazySlot<MediaLightboxSlotProps>(() =>
  import('@marinoscar/memoriahub-web/viewer/ui').then((m) => ({ default: m.MediaLightbox })),
);
const MediaDetailDrawerSlot = lazySlot<MediaDetailDrawerSlotProps>(() =>
  import('@marinoscar/memoriahub-web/viewer/ui').then((m) => ({ default: m.MediaDetailDrawer })),
);
// The platform's inline public-link controls, for the packaged viewer (the lightbox and the drawer).
const LinkSharePanelSlot = lazySlot<LinkSharePanelSlotProps>(() =>
  import('../platform/sharing/LinkSharePanel').then((m) => ({ default: m.LinkSharePanel })),
);
const MediaEnhancementDrawerSlot = lazySlot<MediaEnhancementDrawerSlotProps>(() =>
  import('@marinoscar/memoriahub-web/enhancement/ui').then((m) => ({ default: m.MediaEnhancementDrawer })),
);
const BatchEnhanceDialogSlot = lazySlot<BatchEnhanceDialogSlotProps>(() =>
  import('@marinoscar/memoriahub-web/enhancement/ui').then((m) => ({ default: m.BatchEnhanceDialog })),
);
const MediaShareDialogSlot = lazySlot<MediaShareDialogSlotProps>(() =>
  import('../platform/sharing/MediaShareDialog').then((m) => ({ default: m.MediaShareDialog })),
);
// The two people pickers are the packaged people slice's components.
const AlbumPeopleDialogSlot = lazySlot<AlbumPeopleDialogSlotProps>(() =>
  import('@marinoscar/memoriahub-web/people/ui').then((m) => ({ default: m.AlbumPeopleDialog })),
);
const PersonMultiSelectSlot = lazySlot<PersonMultiSelectSlotProps>(() =>
  import('@marinoscar/memoriahub-web/people/ui').then((m) => ({ default: m.PersonMultiSelect })),
);
// The packaged location slice's dialog reports the merge result; the media slot wants the group's name.
const MergeLocationsDialogSlot = lazySlot<MergeLocationsDialogSlotProps>(() =>
  Promise.all([
    import('@marinoscar/memoriahub-web/location/ui'),
    import('@marinoscar/memoriahub-web/location/headless'),
  ]).then(([dialog, groups]) => {
    const MergeLocationsDialog = dialog.MergeLocationsDialog;
    const Bridge = ({ onMerged, ...rest }: MergeLocationsDialogSlotProps) => (
      <MergeLocationsDialog {...rest} onMerged={(result) => onMerged(groups.mergedGroupName(result))} />
    );
    return { default: Bridge };
  }),
);

/** The slots of the web edition, by name. */
export const appMemoriahubSlots: MemoriahubWebSlots = {
  [APP_SLOT_NAMES.lightbox]: MediaLightboxSlot,
  [APP_SLOT_NAMES.detailDrawer]: MediaDetailDrawerSlot,
  [APP_SLOT_NAMES.enhancementDrawer]: MediaEnhancementDrawerSlot,
  [APP_SLOT_NAMES.batchEnhanceDialog]: BatchEnhanceDialogSlot,
  [APP_SLOT_NAMES.shareDialog]: MediaShareDialogSlot,
  [APP_SLOT_NAMES.albumPeopleDialog]: AlbumPeopleDialogSlot,
  [APP_SLOT_NAMES.personMultiSelect]: PersonMultiSelectSlot,
  [APP_SLOT_NAMES.mergeLocationsDialog]: MergeLocationsDialogSlot,
  [APP_SLOT_NAMES.linkSharePanel]: LinkSharePanelSlot,
};
