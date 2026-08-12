/**
 * tui/Menu.tsx — Generic bordered submenu renderer.
 *
 * Presentational only: given a title, optional subtitle, and a list of
 * {label,value,color} items, renders a <MenuList> (ink-select-input plus digit
 * accelerators and per-item colour) inside the standard cyan bordered box and
 * wires Esc/q → onBack. Used for every NON-root submenu; the root menu keeps
 * its bespoke chrome in HomeMenu but shares the same <MenuList>.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { BOX_BORDER } from './theme.js';
import { MenuList, type MenuListItem } from './MenuList.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MenuProps {
  title: string;
  subtitle?: string;
  items: MenuListItem[];
  onSelect: (value: string) => void;
  onBack: () => void;
  footerHint?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Menu({
  title,
  subtitle,
  items,
  onSelect,
  onBack,
  footerHint,
}: MenuProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === 'q') onBack();
  });

  return (
    <Box
      borderStyle={BOX_BORDER}
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">{title}</Text>
      {subtitle && <Text dimColor>{subtitle}</Text>}

      <Box marginTop={1}>
        <MenuList items={items} onSelect={(item) => onSelect(item.value)} />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{footerHint ?? '[1-9] jump   [↑/↓] move   [Enter] select   [Esc] back'}</Text>
      </Box>
    </Box>
  );
}
