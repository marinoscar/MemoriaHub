/**
 * User Settings → Personal Access Tokens.
 *
 * Migrated onto the shared DataTable in issue #260 (epic #238). What that
 * deleted: a hand-rolled 7-column `<Table size="small">` wrapped in an
 * `overflowX: auto` box — the "scroll sideways and hope" pattern the shared
 * component exists to remove — and a bare `Revoke` button that destroyed a
 * live credential on one click with no confirmation at all.
 *
 * Two things this migration is specifically responsible for (issue #260):
 *
 * 1. **Revoking confirms, and the confirmation names the token.** "Revoke
 *    token CI deploy?" — a card's overflow menu puts Revoke one tap from a
 *    thumb, and a revoked token cannot be un-revoked: whatever was
 *    authenticating with it stops working immediately.
 * 2. **Token material is not exportable.** The `tokenPrefix` column declares
 *    `exportable: false` (`patTable.tsx`), so a CSV export of this table
 *    carries names, dates and statuses and no token material of any kind.
 *
 * Reveal-once is unchanged: `PatTokenRevealDialog` is still the only place a
 * raw token is ever shown, still only at creation, and the table still only
 * ever receives the prefix from the API.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Card,
  CardContent,
  Typography,
  Button,
  Box,
  Alert,
  Snackbar,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import { usePersonalAccessTokens } from '../../hooks/usePersonalAccessTokens';
import { CreatePatDialog } from './CreatePatDialog';
import { PatTokenRevealDialog } from './PatTokenRevealDialog';
import { DataTable, type DataTableRowAction } from '../datatable';
import { PAT_TABLE_ID, buildPatColumns, getTokenStatus } from './patTable';
import type { PatCreatedResponse, PersonalAccessToken } from '../../types';

export function PersonalAccessTokens() {
  const { tokens, isLoading, error, createToken, revokeToken } =
    usePersonalAccessTokens();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [revealDialogOpen, setRevealDialogOpen] = useState(false);
  const [createdTokenValue, setCreatedTokenValue] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleCreated = (response: PatCreatedResponse) => {
    setCreatedTokenValue(response.token);
    setRevealDialogOpen(true);
  };

  const handleRevoke = useCallback(
    async (token: PersonalAccessToken) => {
      setRevoking(token.id);
      try {
        await revokeToken(token.id);
        setSuccessMessage(`Token "${token.name}" revoked`);
      } finally {
        setRevoking(null);
      }
    },
    [revokeToken],
  );

  const columns = useMemo(() => buildPatColumns(), []);

  const rowActions = useMemo<DataTableRowAction<PersonalAccessToken>[]>(
    () => [
      {
        id: 'revoke',
        label: 'Revoke',
        icon: <DeleteForeverIcon fontSize="small" />,
        destructive: true,
        // Only a live token can be revoked, and never twice concurrently.
        disabled: (token) => getTokenStatus(token) !== 'active' || revoking === token.id,
        confirm: {
          title: 'Revoke token?',
          // Names the token: this menu item is one tap away on a phone, and
          // there is no undo.
          description: (token) =>
            `Token "${token.name}" will stop working immediately. Anything authenticating with it will start failing. This cannot be undone.`,
          confirmLabel: 'Revoke',
        },
        onClick: (token) => void handleRevoke(token),
      },
    ],
    [revoking, handleRevoke],
  );

  return (
    <>
      <Card>
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              mb: 1,
            }}
          >
            <Box>
              <Typography variant="h6" gutterBottom>
                Personal Access Tokens
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Create tokens to authenticate API requests without OAuth.
              </Typography>
            </Box>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => setCreateDialogOpen(true)}
              size="small"
            >
              Create Token
            </Button>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {/* Rendered unconditionally; `loading` is a prop, never a branch. */}
          <DataTable<PersonalAccessToken>
            columns={columns}
            rows={tokens}
            rowId={(token) => token.id}
            tableId={PAT_TABLE_ID}
            ariaLabel="Personal access tokens"
            density="compact"
            loading={isLoading}
            emptyState={
              <Typography variant="body2" color="text.secondary">
                No personal access tokens yet. Create one to get started.
              </Typography>
            }
            rowActions={rowActions}
            csvExport={{ filename: 'personal-access-tokens' }}
          />
        </CardContent>
      </Card>

      <CreatePatDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={handleCreated}
        onCreate={createToken}
      />

      <PatTokenRevealDialog
        open={revealDialogOpen}
        onClose={() => {
          setRevealDialogOpen(false);
          setCreatedTokenValue(null);
        }}
        token={createdTokenValue}
      />

      <Snackbar
        open={Boolean(successMessage)}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage ?? undefined}
      />
    </>
  );
}
