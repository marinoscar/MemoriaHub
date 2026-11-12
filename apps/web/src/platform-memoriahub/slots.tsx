/**
 * The components the packaged media slice asks its host for (`slots` of
 * `MemoriahubWebHost`): the ones that belong to slices that have not moved into
 * `@marinoscar/memoriahub-web` yet (the lightbox and detail drawer), the
 * platform's share dialog, and five components of packaged slices that stay
 * slots for good because those slices import the media slice, so the media
 * pages cannot import them: the two people pickers, the AI enhancement drawer
 * and batch dialog and the location-merge dialog. Those five are bound to the
 * packaged components (the merge dialog through a small bridge). Each is lazy, so the page that needs it keeps it out of
 * the main chunk exactly as before. A slot is deleted when its component moves
 * into the package and the slice that owns it can import it.
 */
import { Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { MemoriahubWebSlots } from '@marinoscar/memoriahub-web/core/headless';
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
  import('../components/media/MediaLightbox').then((m) => ({ default: m.MediaLightbox })),
);
const MediaDetailDrawerSlot = lazySlot<MediaDetailDrawerSlotProps>(() =>
  import('../components/media/MediaDetailDrawer').then((m) => ({ default: m.MediaDetailDrawer })),
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
};
