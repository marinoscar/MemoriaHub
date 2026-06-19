import { Grid, Typography, Box, CircularProgress } from '@mui/material';
import { PersonCard } from './PersonCard';
import type { PersonListItem } from '../../services/face';

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
          <PersonCard person={person} onClick={onPersonClick} />
        </Grid>
      ))}
    </Grid>
  );
}
