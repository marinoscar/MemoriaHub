/**
 * tui/Menu.tsx — Generic bordered submenu renderer.
 *
 * Presentational only: given a title, optional subtitle, and a list of
 * {label,value} items, renders an ink-select-input inside the standard cyan
 * bordered box and wires Esc/q → onBack. Used for every NON-root submenu; the
 * root menu keeps its bespoke chrome in HomeMenu.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MenuItem {
  label: string;
  value: string;
}

interface MenuProps {
  title: string;
  subtitle?: string;
  items: MenuItem[];
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

  function handleSelect(item: MenuItem): void {
    onSelect(item.value);
  }

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
        <SelectInput items={items} onSelect={handleSelect} />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{footerHint ?? '[Esc] back'}</Text>
      </Box>
    </Box>
  );
}
