/**
 * The phone bottom bar — this app's binding of the packaged `ShellBottomNav`
 * (`@marinoscar/platform-web/shell/ui`, RETRO-F1 #571).
 *
 * The bar (its own `down('sm')` self-gate, breakpoint gate 2, the exact
 * complement of `ShellLayout`'s rail gate; compact labels with full accessible
 * names; active state from the destination model, so `/bursts` selects Review
 * and `/albums/:id` selects Collections) is the package's. This binding hands
 * it the NON-PINNED destinations (`PHONE_BAR_NAVIGATION`): Photos,
 * Collections, Search, Review. The Console is not a tab (spec §4.4), so the
 * bar never overflows into a More sheet; admins reach it from the avatar menu.
 */
import { ShellBottomNav } from '@marinoscar/platform-web/shell/ui';
import { PHONE_BAR_NAVIGATION } from '../../config/shell';

export function BottomNav() {
  return <ShellBottomNav navigation={PHONE_BAR_NAVIGATION} />;
}

export default BottomNav;
