/**
 * tui/HomeMenu.tsx — Root home menu for the TUI.
 *
 * Displays:
 *   - MemoriaHub banner
 *   - Identity line (server + email if logged in)
 *   - DB path
 *   - ink-select-input menu
 *
 * If not logged in shows a restricted menu (Login / Help / Quit only).
 */

import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { CliConfig } from '../config.js';
import { dbPath } from '../paths.js';
import { BOX_BORDER, banner, dim } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MenuAction =
  | 'login'
  | 'folders'
  | 'circles'
  | 'sync-all'
  | 'sync-select'
  | 'status'
  | 'retry'
  | 'settings'
  | 'help'
  | 'quit';

type MenuItem = { label: string; value: MenuAction };

interface HomeMenuProps {
  config: CliConfig | null;
  identity: string | null;   // email from /api/auth/me, null if not logged in
  activeCircleName?: string | null;
  onSelect: (action: MenuAction) => void;
}

// ---------------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------------

const ALL_ITEMS: MenuItem[] = [
  { label: 'Login / Change server',    value: 'login'       },
  { label: 'Manage folders',           value: 'folders'     },
  { label: 'Manage circles',           value: 'circles'     },
  { label: 'Sync all folders',         value: 'sync-all'    },
  { label: 'Sync selected folders',    value: 'sync-select' },
  { label: 'Status',                   value: 'status'      },
  { label: 'Retry failed files',       value: 'retry'       },
  { label: 'Settings',                 value: 'settings'    },
  { label: 'Help',                     value: 'help'        },
  { label: 'Quit',                     value: 'quit'        },
];

const LOGGED_OUT_ACTIONS: MenuAction[] = ['login', 'help', 'quit'];

// ---------------------------------------------------------------------------
// Banner lines
// ---------------------------------------------------------------------------

const BANNER = [
  ' __  __                            _       _   _       _     ',
  '|  \\/  | ___ _ __ ___   ___  _ __(_) __ _| | | |_   _| |__  ',
  "| |\\/| |/ _ \\ '_ ` _ \\ / _ \\| '__| |/ _` | |_| | | | | '_ \\ ",
  '| |  | |  __/ | | | | | (_) | |  | | (_| |  _  | |_| | |_) |',
  '|_|  |_|\\___|_| |_| |_|\\___/|_|  |_|\\__,_|_| |_|\\__,_|_.__/ ',
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HomeMenu({
  config,
  identity,
  activeCircleName,
  onSelect,
}: HomeMenuProps): React.ReactElement {
  const isLoggedIn = Boolean(config && identity);

  const items: MenuItem[] = ALL_ITEMS.filter(
    (item) => isLoggedIn || LOGGED_OUT_ACTIONS.includes(item.value),
  );

  function handleSelect(item: MenuItem): void {
    onSelect(item.value);
  }

  return (
    <Box flexDirection="column" gap={1}>
      {/* Banner */}
      <Box flexDirection="column">
        {BANNER.map((line, i) => (
          <Text key={i}>{banner(line)}</Text>
        ))}
        <Text dimColor>  Import and sync photos/videos to your MemoriaHub server</Text>
      </Box>

      {/* Identity box */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        {isLoggedIn ? (
          <>
            <Box flexDirection="row" gap={2}>
              <Text dimColor>Server:</Text>
              <Text color="cyan">{config!.serverUrl}</Text>
            </Box>
            <Box flexDirection="row" gap={2}>
              <Text dimColor>User:  </Text>
              <Text color="green">{identity}</Text>
            </Box>
            {activeCircleName && (
              <Box flexDirection="row" gap={2}>
                <Text dimColor>Circle:</Text>
                <Text color="cyan">{activeCircleName}</Text>
              </Box>
            )}
          </>
        ) : (
          <Text color="yellow">Not logged in — select Login to configure your server.</Text>
        )}
        <Box flexDirection="row" gap={2}>
          <Text dimColor>DB:</Text>
          <Text dimColor>{dim(dbPath())}</Text>
        </Box>
      </Box>

      {/* Menu */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Menu</Text>
        <Text dimColor>Use arrow keys and Enter to navigate</Text>
        <Box marginTop={1}>
          <SelectInput items={items} onSelect={handleSelect} />
        </Box>
      </Box>
    </Box>
  );
}
