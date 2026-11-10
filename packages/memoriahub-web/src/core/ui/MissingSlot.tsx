import type { ReactNode } from 'react';

import { useMemoriahubSlot } from '../headless/host.js';

/**
 * Declares a typed bridge to a component the host supplies for a slice that has
 * not moved into the package yet.
 *
 * @param name - the slot name the host registers the component under.
 * @returns a component that renders the host's component with the same props,
 * or nothing when the host supplies none.
 *
 * @stability experimental
 */
export function defineHostSlot<P extends object>(name: string): (props: P) => ReactNode {
  function HostSlotComponent(props: P): ReactNode {
    const Slot = useMemoriahubSlot<P>(name);
    return Slot ? <Slot {...props} /> : null;
  }
  HostSlotComponent.displayName = `HostSlot(${name})`;
  return HostSlotComponent;
}
