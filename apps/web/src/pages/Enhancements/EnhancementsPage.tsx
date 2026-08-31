import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, Alert, Tabs, Tab, Typography, Stack } from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { useCircle } from '../../hooks/useCircle';
import { PendingEnhancementsTab } from './PendingEnhancementsTab';
import { scrollableTabsProps } from '../../components/common/tabs';

/**
 * Tab keys. These are the `?tab=` values on the wire, so they are part of the
 * page's URL contract — renaming one breaks bookmarks.
 */
const TABS = ['pending', 'enhanced', 'history'] as const;
export type EnhancementsTab = (typeof TABS)[number];

const DEFAULT_TAB: EnhancementsTab = 'pending';

function parseTab(raw: string | null): EnhancementsTab {
  return (TABS as readonly string[]).includes(raw ?? '')
    ? (raw as EnhancementsTab)
    : DEFAULT_TAB;
}

/**
 * AI Enhancements hub (issue #201).
 *
 * Three tabs — Pending review / Enhanced photos / History. Only the first is
 * implemented in PR1; the other two land in PR3 and render a placeholder here
 * so the shell's tab contract (and its `?tab=` URL keys) is settled up front.
 */
export default function EnhancementsPage() {
  const { activeCircle } = useCircle();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<EnhancementsTab>(() =>
    parseTab(searchParams.get('tab')),
  );

  // Mirror a non-default tab to the URL so the view is shareable/restorable.
  // `searchParams` is deliberately excluded from the deps — including it would
  // re-run on every replace and loop (same rationale as LocationSuggestionsPage).
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    if (tab !== DEFAULT_TAB) params.set('tab', tab);
    else params.delete('tab');
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, setSearchParams]);

  /**
   * Optional bulk-enhance batch filter (epic #420, issue #423), set when a user
   * follows "Review N results" from a batch's progress page. It lives in the
   * URL rather than in state so the narrowed view survives a reload and can be
   * shared — and so clearing the chip is just dropping the param.
   */
  const batchId = searchParams.get('batchId') ?? undefined;
  const clearBatchFilter = useCallback(() => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.delete('batchId');
        return params;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to review AI enhancements.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <AutoFixHighIcon color="primary" />
        <Typography variant="h4" component="h1">
          AI Enhancements
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Every photo you have sent through the AI enhancer, in one place.
      </Typography>

      <Tabs
        value={tab}
        onChange={(_, v: EnhancementsTab) => setTab(v)}
        {...scrollableTabsProps}
        sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab label="Pending review" value="pending" />
        <Tab label="Enhanced photos" value="enhanced" />
        <Tab label="History" value="history" />
      </Tabs>

      {/* Only the active tab's data is fetched — each tab owns its own hook
          call, so mounting one never triggers the others' requests. */}
      {tab === 'pending' && (
        <PendingEnhancementsTab
          circleId={activeCircle.id}
          batchId={batchId}
          onClearBatchFilter={clearBatchFilter}
        />
      )}

      {tab === 'enhanced' && (
        <Alert severity="info">
          Enhanced photos — a gallery of every enhancement you kept — is coming
          soon.
        </Alert>
      )}

      {tab === 'history' && (
        <Alert severity="info">
          History — the full audit trail of past enhancements — is coming soon.
        </Alert>
      )}
    </Box>
  );
}
