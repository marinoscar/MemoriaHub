/**
 * tui/BackupVerify.tsx — Ink surface for `backup verify` (issue #320,
 * epic #308).
 *
 * Verification is pure local disk I/O against the root's catalog, so unlike
 * the backup run there is no daemon to attach to — this screen always drives
 * the engine in-process through runVerify(), subscribing to the same
 * VerifyEmitter events the headless renderer consumes. Unmounting sets the
 * cooperative cancel flag so a half-finished sweep never outlives the UI.
 *
 * Keys: [Enter] standard verify · [d] deep verify · [c] cancel · [Esc/q] back.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';

import { getDb } from '../db/database.js';
import { SettingsRepo } from '../repo/settings.js';
import { openCatalogDb, CatalogOpenError } from '../backup/catalog-db.js';
import {
  DEFAULT_VERIFY_CONCURRENCY,
  VERIFY_EV,
  VerifyEmitter,
  isVerifyFailure,
  runVerify,
  type VerifyItemResult,
  type VerifyStartedPayload,
  type VerifySummary,
} from '../backup/verify.js';
import { BOX_BORDER } from './theme.js';

export interface BackupVerifyProps {
  onBack: () => void;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = '';
  for (const u of units) {
    value /= 1000;
    unit = u;
    if (value < 1000) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

export function BackupVerify({ onBack }: BackupVerifyProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('idle');
  const [deep, setDeep] = useState<boolean>(false);
  const [total, setTotal] = useState<number>(0);
  const [done, setDone] = useState<number>(0);
  const [failedCount, setFailedCount] = useState<number>(0);
  const [failures, setFailures] = useState<VerifyItemResult[]>([]);
  const [summary, setSummary] = useState<VerifySummary | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  const cancelledRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);

  const rootRef = useRef<string | null>(null);
  if (rootRef.current === null) {
    try {
      rootRef.current = new SettingsRepo(getDb()).backupRoot();
    } catch {
      rootRef.current = null;
    }
  }
  const root = rootRef.current;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Cooperative cancel: an in-flight sweep must not outlive the screen.
      cancelledRef.current = true;
    };
  }, []);

  const start = useCallback(
    async (deepMode: boolean): Promise<void> => {
      if (!root) return;
      cancelledRef.current = false;
      setDeep(deepMode);
      setPhase('running');
      setDone(0);
      setFailedCount(0);
      setFailures([]);
      setSummary(null);
      setErrorMsg('');

      let db;
      try {
        db = openCatalogDb(root);
      } catch (err) {
        setErrorMsg(
          err instanceof CatalogOpenError
            ? err.message
            : `Could not open the backup catalog: ${err instanceof Error ? err.message : String(err)}`,
        );
        setPhase('error');
        return;
      }

      const emitter = new VerifyEmitter();
      emitter.on(VERIFY_EV.STARTED, (p: VerifyStartedPayload) => {
        if (mountedRef.current) setTotal(p.total);
      });
      emitter.on(VERIFY_EV.ITEM_DONE, (p: VerifyItemResult) => {
        if (!mountedRef.current) return;
        setDone((n) => n + 1);
        if (isVerifyFailure(p.outcome)) {
          setFailedCount((n) => n + 1);
          setFailures((prev) => (prev.length >= 20 ? prev : [...prev, p]));
        }
      });

      try {
        const result = await runVerify(
          { root, deep: deepMode, concurrency: DEFAULT_VERIFY_CONCURRENCY },
          { db, isCancelled: () => cancelledRef.current },
          emitter,
        );
        if (mountedRef.current) {
          setSummary(result);
          setPhase('done');
        }
      } catch (err) {
        if (mountedRef.current) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setPhase('error');
        }
      } finally {
        db.close();
      }
    },
    [root],
  );

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      cancelledRef.current = true;
      onBack();
      return;
    }
    if (phase === 'running') {
      if (input === 'c') cancelledRef.current = true;
      return;
    }
    if (input === 'd') {
      void start(true);
      return;
    }
    if (key.return) void start(false);
  });

  if (!root) {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">MemoriaHub — Verify Backup</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">No backup root is configured on this machine.</Text>
          <Text color="cyan">  memoriahub backup init --dest &lt;dir&gt;</Text>
          <Text> </Text>
          <Text dimColor>[Esc/q] back</Text>
        </Box>
      </Box>
    );
  }

  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;

  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">MemoriaHub — Verify Backup</Text>
      <Text dimColor>{root}</Text>

      {phase === 'idle' ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Standard verify checks existence and size for every stored item, and fully hashes
          </Text>
          <Text>the items whose bytes have not been proven since they landed.</Text>
          <Text dimColor>Deep verify hashes every file — slower, but complete.</Text>
          <Text> </Text>
          <Text dimColor>[Enter] standard · [d] deep · [Esc/q] back</Text>
        </Box>
      ) : null}

      {phase === 'running' ? (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color="green">
              <Spinner type="dots" />{' '}
            </Text>
            <Text>
              {`Verifying${deep ? ' (deep)' : ''}: ${done}/${total} (${pct}%)  `}
              <Text color={failedCount > 0 ? 'red' : undefined}>{`${failedCount} failed`}</Text>
            </Text>
          </Box>
          <Text dimColor>[c] cancel · [Esc/q] back</Text>
        </Box>
      ) : null}

      {phase === 'done' && summary ? (
        <Box marginTop={1} flexDirection="column">
          <Text>{`Mode        : ${summary.deep ? 'deep (every file hashed)' : 'standard'}`}</Text>
          <Text>{`Checked     : ${summary.checked} item(s)`}</Text>
          <Text>{`Hashed      : ${summary.hashed} item(s), ${formatBytes(summary.bytesHashed)}`}</Text>
          <Text>{`Verified OK : ${summary.ok}`}</Text>
          <Text color={summary.failed > 0 ? 'red' : undefined}>{`Failed      : ${summary.failed}`}</Text>
          <Text>{`Duration    : ${(summary.durationMs / 1000).toFixed(1)}s`}</Text>

          {failures.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text color="yellow">Failures:</Text>
              {failures.slice(0, 10).map((f) => (
                <Text key={f.mediaItemId} color="red">
                  {`  ✗ ${f.relPath.slice(-58)}  ${f.outcome}`}
                </Text>
              ))}
              <Text dimColor>
                Failed items were marked for re-download — the next backup run re-fetches them.
              </Text>
            </Box>
          ) : null}

          <Box marginTop={1}>
            <Text dimColor>[Enter] verify again · [d] deep verify · [Esc/q] back</Text>
          </Box>
        </Box>
      ) : null}

      {phase === 'error' ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">{errorMsg}</Text>
          <Text dimColor>[Enter] retry · [Esc/q] back</Text>
        </Box>
      ) : null}
    </Box>
  );
}
