import { useState } from 'react';
import {
  Card,
  CardContent,
  Typography,
  Button,
  Box,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  Alert,
  CircularProgress,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { usePersonalAccessTokens } from '../../hooks/usePersonalAccessTokens';
import { CreatePatDialog } from './CreatePatDialog';
import { PatTokenRevealDialog } from './PatTokenRevealDialog';
import type { PatCreatedResponse } from '../../types';

function getTokenStatus(token: {
  expiresAt: string;
  revokedAt: string | null;
}): 'active' | 'expired' | 'revoked' {
  if (token.revokedAt) return 'revoked';
  if (new Date(token.expiresAt) < new Date()) return 'expired';
  return 'active';
}

export function PersonalAccessTokens() {
  const { tokens, isLoading, error, createToken, revokeToken } = usePersonalAccessTokens();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [revealDialogOpen, setRevealDialogOpen] = useState(false);
  const [createdTokenValue, setCreatedTokenValue] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const handleCreated = (response: PatCreatedResponse) => {
    setCreatedTokenValue(response.token);
    setRevealDialogOpen(true);
  };

  const handleRevoke = async (id: string) => {
    setRevoking(id);
    try {
      await revokeToken(id);
    } finally {
      setRevoking(null);
    }
  };

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

          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={32} />
            </Box>
          ) : tokens.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ textAlign: 'center', py: 4 }}
            >
              No personal access tokens yet. Create one to get started.
            </Typography>
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Token Prefix</TableCell>
                    <TableCell>Created</TableCell>
                    <TableCell>Expires</TableCell>
                    <TableCell>Last Used</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tokens.map((token) => {
                    const status = getTokenStatus(token);
                    const isDisabled = status !== 'active' || revoking === token.id;
                    return (
                      <TableRow key={token.id}>
                        <TableCell>{token.name}</TableCell>
                        <TableCell>
                          <Typography
                            variant="body2"
                            sx={{ fontFamily: 'monospace' }}
                          >
                            {token.tokenPrefix}...
                          </Typography>
                        </TableCell>
                        <TableCell>
                          {new Date(token.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          {new Date(token.expiresAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          {token.lastUsedAt
                            ? new Date(token.lastUsedAt).toLocaleDateString()
                            : 'Never'}
                        </TableCell>
                        <TableCell>
                          {status === 'active' && (
                            <Chip label="Active" color="success" size="small" />
                          )}
                          {status === 'expired' && (
                            <Chip label="Expired" size="small" />
                          )}
                          {status === 'revoked' && (
                            <Chip label="Revoked" color="error" size="small" />
                          )}
                        </TableCell>
                        <TableCell align="right">
                          <Button
                            size="small"
                            color="error"
                            variant="outlined"
                            disabled={isDisabled}
                            onClick={() => handleRevoke(token.id)}
                          >
                            {revoking === token.id ? 'Revoking...' : 'Revoke'}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Box>
          )}
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
    </>
  );
}
