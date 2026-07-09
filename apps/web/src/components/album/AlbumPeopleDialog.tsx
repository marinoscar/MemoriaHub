/**
 * AlbumPeopleDialog — shows the people recognized in a single album.
 *
 * Fetches GET /api/people?circleId=&albumId= and renders the shared PersonGrid.
 * Clicking a person mirrors PeoplePage's "View their photos" affordance by
 * navigating to the media library filtered to that person.
 */

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  IconButton,
  Box,
  Alert,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { PersonGrid } from '../people/PersonGrid';
import { listPeople } from '../../services/face';
import type { PersonListItem } from '../../services/face';

interface AlbumPeopleDialogProps {
  open: boolean;
  onClose: () => void;
  albumId: string;
  circleId: string;
}

export function AlbumPeopleDialog({ open, onClose, albumId, circleId }: AlbumPeopleDialogProps) {
  const navigate = useNavigate();
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listPeople(circleId, { albumId, includeUnlabeled: true, pageSize: 100 })
      .then((resp) => {
        if (!cancelled) setPeople(resp.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load people');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, albumId, circleId]);

  const handlePersonClick = (person: PersonListItem) => {
    onClose();
    navigate(
      `/media?personId=${person.id}&circleId=${circleId}&personName=${encodeURIComponent(
        person.name ?? 'Unknown',
      )}`,
    );
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ pr: 6 }}>
        People
        <IconButton
          aria-label="Close people"
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {error ? (
          <Alert severity="error">{error}</Alert>
        ) : (
          <Box sx={{ minHeight: 120 }}>
            <PersonGrid
              people={people}
              onPersonClick={handlePersonClick}
              loading={loading}
              emptyMessage="No recognized people in this album"
            />
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
