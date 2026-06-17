import { useEffect, useState } from 'react';
import { Grid, Typography, Box, CircularProgress } from '@mui/material';
import { PersonCard } from './PersonCard';
import type { PersonListItem } from '../../services/face';
import { listMedia } from '../../services/media';
import type { MediaItem } from '../../types/media';

interface PersonCardContainerProps {
  person: PersonListItem;
  onClick: (person: PersonListItem) => void;
}

function PersonCardContainer({ person, onClick }: PersonCardContainerProps) {
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!person.coverFace) return;
    // Fetch the cover media item to get its thumbnailUrl
    listMedia({ personId: person.id, pageSize: 1 })
      .then((resp) => {
        const item = resp.items.find((m: MediaItem) => m.id === person.coverFace!.mediaItemId)
          ?? resp.items[0];
        if (item?.thumbnailUrl) setImageUrl(item.thumbnailUrl);
      })
      .catch(() => undefined);
  }, [person.id, person.coverFace]);

  return <PersonCard person={person} imageUrl={imageUrl} onClick={onClick} />;
}

interface PersonGridProps {
  people: PersonListItem[];
  onPersonClick: (person: PersonListItem) => void;
  loading?: boolean;
  emptyMessage?: string;
}

export function PersonGrid({ people, onPersonClick, loading, emptyMessage }: PersonGridProps) {
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (people.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="body2" color="text.secondary">
          {emptyMessage ?? 'No people found'}
        </Typography>
      </Box>
    );
  }

  return (
    <Grid container spacing={2}>
      {people.map((person) => (
        <Grid item key={person.id} xs={6} sm={4} md={3} lg={2}>
          <PersonCardContainer person={person} onClick={onPersonClick} />
        </Grid>
      ))}
    </Grid>
  );
}
