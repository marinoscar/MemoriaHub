/**
 * tui/MenuList.tsx — The one selectable list both menu renderers use.
 *
 * HomeMenu (root, with banner/identity chrome) and the generic <Menu>
 * (every non-root submenu) previously each dropped a bare <SelectInput/> into
 * their own box, which meant any list-level behaviour had to be implemented —
 * and kept in sync — twice. This component owns all of it (issue #413):
 *
 *   - per-item colour, so a destructive entry (factory reset, delete
 *     screenshots) can render red — ink-select-input's `itemComponent` only
 *     receives {isSelected, label}, so the colour is resolved through a
 *     label→colour map built from the same items array
 *   - the one place the 'N.' accelerator labels are rendered, so the digit
 *     shortcuts are discoverable rather than hidden
 *
 * On digit accelerators: ink-select-input v6 ALREADY selects item N on a 1–9
 * keypress (and moves with j/k as well as the arrows). What was missing is any
 * indication that it does — so the accelerators here are a labelling change,
 * not a second key handler. Adding one would double-fire every digit, since
 * both handlers would call onSelect for the same keystroke.
 *
 * Labels arrive fully decorated from `menuItemLabel()` in menu-config.ts
 * (chevron, ellipsis, accelerator prefix); this component never edits them.
 */

import React, { useMemo } from 'react';
import { Text } from 'ink';
import SelectInput from 'ink-select-input';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MenuListItem {
  label: string;
  value: string;
  /** Optional colour override (e.g. 'red' for a destructive action). */
  color?: string;
}

interface MenuListProps {
  items: MenuListItem[];
  onSelect: (item: MenuListItem) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MenuList({ items, onSelect }: MenuListProps): React.ReactElement {
  // ink-select-input remounts its item component whenever the identity of the
  // `itemComponent` prop changes, so build it once per items array.
  const ItemComponent = useMemo(() => {
    const colorByLabel = new Map<string, string | undefined>(
      items.map((it) => [it.label, it.color]),
    );
    function MenuListItemView({
      isSelected,
      label,
    }: {
      isSelected?: boolean;
      label: string;
    }): React.ReactElement {
      const explicit = colorByLabel.get(label);
      // With no explicit colour, mirror ink-select-input's default: the
      // highlighted row is cyan, everything else inherits.
      const color = explicit ?? (isSelected ? 'cyan' : undefined);
      return (
        <Text color={color} bold={Boolean(explicit) && isSelected}>
          {label}
        </Text>
      );
    }
    return MenuListItemView;
  }, [items]);

  return <SelectInput items={items} itemComponent={ItemComponent} onSelect={(it) => onSelect(it as MenuListItem)} />;
}
