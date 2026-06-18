import { useEffect, useState } from 'react';
import { Grid, Typography, Box, CircularProgress } from '@mui/material';
import { PersonCard } from './PersonCard';
import type { PersonListItem } from '../../services/face';
import { getMedia } from '../../services/media';

interface PersonCardContainerProps {
  person: PersonListItem;
  onClick: (person: PersonListItem) => void;
}

function PersonCardContainer({ person, onClick }: PersonCardContainerProps) {
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!person.coverFace) return;
    // Fetch the full media item to get downloadUrl (full-res) with thumbnailUrl fallback
    getMedia(person.coverFace.mediaItemId)
      .then((item) => {
        const url = item.downloadUrl ?? item.thumbnailUrl;
        if (url) setImageUrl(url);
      })
      .catch(() => undefined);
  }, [person.coverFace]);

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
        <Grid key={person.id} size={{ xs: 6, sm: 4, md: 3, lg: 2 }}>
          <PersonCardContainer person={person} onClick={onPersonClick} />
        </Grid>
      ))}
    </Grid>
  );
}
