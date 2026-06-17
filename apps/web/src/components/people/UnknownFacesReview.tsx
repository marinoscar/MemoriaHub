import { useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Button,
  Stack,
  Alert,
  CircularProgress,
  Divider,
  Chip,
} from '@mui/material';
import { Groups as GroupsIcon, AutoFixHigh as ClusterIcon } from '@mui/icons-material';
import { PersonGrid } from './PersonGrid';
import type { PersonListItem, ClusterResult } from '../../services/face';

interface UnknownFacesReviewProps {
  unlabeledPeople: PersonListItem[];
  onPersonClick: (person: PersonListItem) => void;
  onCluster: () => Promise<ClusterResult>;
  onRename: (personId: string, name: string) => Promise<void>;
  canCluster: boolean;   // true if user has collaborator+ role in the circle
  loading?: boolean;
}

export function UnknownFacesReview({
  unlabeledPeople,
  onPersonClick,
  onCluster,
  canCluster,
  loading,
}: UnknownFacesReviewProps) {
  const [clusterLoading, setClusterLoading] = useState(false);
  const [clusterResult, setClusterResult] = useState<ClusterResult | null>(null);
  const [clusterError, setClusterError] = useState<string | null>(null);

  const handleCluster = async () => {
    setClusterLoading(true);
    setClusterError(null);
    setClusterResult(null);
    try {
      const result = await onCluster();
      setClusterResult(result);
    } catch (err) {
      setClusterError(err instanceof Error ? err.message : 'Clustering failed');
    } finally {
      setClusterLoading(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <GroupsIcon color="action" />
        <Typography variant="h6">Unknown People</Typography>
        <Chip label={unlabeledPeople.length} size="small" />
      </Stack>

      {canCluster && (
        <Box sx={{ mb: 2 }}>
          <Button
            variant="outlined"
            startIcon={clusterLoading ? <CircularProgress size={16} /> : <ClusterIcon />}
            onClick={() => void handleCluster()}
            disabled={clusterLoading}
          >
            Find People
          </Button>
          {clusterResult && (
            <Alert severity="success" sx={{ mt: 1 }}>
              Found {clusterResult.clustersCreated} new group
              {clusterResult.clustersCreated !== 1 ? 's' : ''},{' '}
              {clusterResult.facesAssigned} face
              {clusterResult.facesAssigned !== 1 ? 's' : ''} assigned
            </Alert>
          )}
          {clusterError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {clusterError}
            </Alert>
          )}
        </Box>
      )}

      <Divider sx={{ mb: 2 }} />

      {unlabeledPeople.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No unknown people clusters found. Run "Find People" to group unrecognized faces.
        </Typography>
      ) : (
        <PersonGrid
          people={unlabeledPeople}
          onPersonClick={onPersonClick}
          loading={loading}
          emptyMessage="No unknown clusters"
        />
      )}
    </Paper>
  );
}
