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
import { BOX_BORDER, brandColorize, dim } from './theme.js';
import { MENU_TREE, visibleChildren, type MenuNode } from './menu-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MenuItem = { label: string; value: string; node: MenuNode };

interface HomeMenuProps {
  config: CliConfig | null;
  identity: string | null;   // email from /api/auth/me, null if not logged in
  activeCircleName?: string | null;
  onSelect: (node: MenuNode) => void;
  updateInfo?: { updateAvailable: boolean; latestVersion: string | null } | null;
  currentVersion?: string;
}

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

// Pre-tinted with the brand palette so the wordmark matches the app logo.
const BRANDED_BANNER = brandColorize(BANNER);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HomeMenu({
  config,
  identity,
  activeCircleName,
  onSelect,
  updateInfo,
  currentVersion,
}: HomeMenuProps): React.ReactElement {
  const isLoggedIn = Boolean(config && identity);

  const nodes = visibleChildren(MENU_TREE, isLoggedIn);

  const items: MenuItem[] = nodes.map((node, i) => ({
    label: node.kind === 'submenu' ? `${node.label} ▸` : node.label,
    value: String(i),
    node,
  }));

  function handleSelect(item: { value: string }): void {
    const match = items.find((it) => it.value === item.value);
    if (match) onSelect(match.node);
  }

  return (
    <Box flexDirection="column" gap={1}>
      {/* Banner */}
      <Box flexDirection="column">
        {BRANDED_BANNER.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        <Text dimColor>  Import and sync photos/videos to your MemoriaHub server</Text>
      </Box>

      {/* Update-available notice — shown in yellow between the banner and identity box */}
      {updateInfo?.updateAvailable && (
        <Box>
          <Text color="yellow">
            {`⬆ Update available: ${updateInfo.latestVersion} (you have ${currentVersion ?? '?'}) — run 'git pull' in the MemoriaHub repo and rebuild the CLI`}
          </Text>
        </Box>
      )}

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
