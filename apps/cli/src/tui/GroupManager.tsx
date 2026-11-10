/**
 * tui/GroupManager.tsx — Interactive library selector (RETRO-I6, #588; formerly
 * CircleManager): "My library" and the caller's groups, from ApiClient.listOwnerScopes.
 * The menu node id stays `circles`, so existing menu paths still work.
 *
 * Fetches the user's circles from the server and lets them:
 *   up/down — navigate rows
 *   Enter   — set as active circle (saves config)
 *   Esc/q   — back to home
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from './ink.js';
import { ApiClient, type Circle } from '../api.js';
import { saveConfig, type CliConfig } from '../config.js';
import { ownerScopeFields } from '../owner-scope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GroupManagerProps {
  config: CliConfig;
  /**
   * Called after the active circle is changed and persisted, with the updated
   * config. The parent MUST use this to refresh its in-memory config so that
   * downstream screens (sync dashboard, home) see the new activeCircleId —
   * otherwise the change persists to disk but the running session stays stale
   * and a subsequent sync fails with "No target circle".
   */
  onConfigChange?: (config: CliConfig) => void;
  onBack: () => void;
}

type LoadState = 'loading' | 'ready' | 'error';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GroupManager({ config, onConfigChange, onBack }: GroupManagerProps): React.ReactElement {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [circles, setCircles]     = useState<Circle[]>([]);
  const [errorMsg, setErrorMsg]   = useState('');
  const [selected, setSelected]   = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [activeCircleId, setActiveCircleId] = useState(config.activeCircleId);

  // Load circles on mount
  useEffect(() => {
    let cancelled = false;

    async function fetchCircles(): Promise<void> {
      try {
        const api = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });
        const list = await api.listCircles();
        if (cancelled) return;
        setCircles(list);

        // Pre-select the currently active circle if set
        if (config.activeCircleId) {
          const idx = list.findIndex((c) => c.id === config.activeCircleId);
          if (idx >= 0) setSelected(idx);
        }

        setLoadState('ready');
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setLoadState('error');
      }
    }

    void fetchCircles();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (key.escape || input === 'q') { onBack(); return; }

    if (loadState !== 'ready') return;

    if (key.upArrow)   { setSelected((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSelected((s) => Math.min(circles.length - 1, s + 1)); return; }

    if (key.return && circles.length > 0) {
      const circle = circles[selected];
      if (!circle) return;
      const newConfig = { ...config, ...ownerScopeFields(circle) };
      saveConfig(newConfig);
      setActiveCircleId(circle.id);
      // Propagate to the parent so the in-memory session config matches what we
      // just wrote to disk; otherwise the sync dashboard keeps the stale config.
      onConfigChange?.(newConfig);
      setStatusMsg(`Active library set to: ${circle.name}`);
      return;
    }
  });

  // ---- Loading ----
  if (loadState === 'loading') {
    return (
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Libraries</Text>
        <Box marginTop={1}>
          <Text dimColor>Loading libraries…</Text>
        </Box>
      </Box>
    );
  }

  // ---- Error ----
  if (loadState === 'error') {
    return (
      <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="red">Libraries — Error</Text>
        <Box marginTop={1}>
          <Text color="red">{errorMsg}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Esc/q] back</Text>
        </Box>
      </Box>
    );
  }

  // ---- Ready ----
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Libraries ({circles.length})</Text>

      {circles.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No libraries found. Create a group on the web app first.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {/* Header row */}
          <Box flexDirection="row" gap={1}>
            <Text bold dimColor>{' '.padEnd(2)}</Text>
            <Text bold dimColor>{'Name'.padEnd(28)}</Text>
            <Text bold dimColor>{'Personal'.padEnd(10)}</Text>
            <Text bold dimColor>{'Active'.padEnd(8)}</Text>
          </Box>
          {circles.map((c, i) => {
            const isSelected = i === selected;
            const isActive = c.id === activeCircleId;
            return (
              <Box key={c.id} flexDirection="row" gap={1}>
                <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▶' : ' '} </Text>
                <Text color={isSelected ? 'cyanBright' : undefined}>
                  {c.name.slice(0, 26).padEnd(28)}
                </Text>
                <Text color={c.isPersonal ? 'cyan' : undefined} dimColor={!c.isPersonal}>
                  {c.isPersonal ? 'yes' : 'no '}{'       '}
                </Text>
                <Text color={isActive ? 'green' : undefined}>
                  {isActive ? '*' : ''}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Status messages */}
      {statusMsg && (
        <Box marginTop={1}>
          <Text color="green">{statusMsg}</Text>
        </Box>
      )}

      {/* Key hints */}
      <Box flexDirection="row" gap={3} marginTop={1}>
        <Text dimColor>[up/down] select</Text>
        <Text dimColor>[Enter] set active</Text>
        <Text dimColor>[q/Esc] back</Text>
      </Box>
    </Box>
  );
}
