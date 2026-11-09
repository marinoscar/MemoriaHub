/**
 * @deprecated RETRO-I6 (#588): the active library is the owner scope
 * (`contexts/OwnerScopeContext.tsx`). This module re-exports it under the
 * former names so the pages that still read `useCircleContext()` keep working
 * until each is renamed to `useOwnerScope()`.
 */
export {
  OwnerScopeContext as CircleContext,
  OwnerScopeProvider as CircleProvider,
  useOwnerScope as useCircleContext,
} from './OwnerScopeContext';
export type { OwnerScopeContextValue as CircleContextValue } from './OwnerScopeContext';
