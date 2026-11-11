import { Grid, Typography, Box, CircularProgress } from '@mui/material';
import { PersonCard } from './PersonCard.js';
import type { PersonListItem } from '../../headless/services/people.js';

/**
 * Props of {@link PersonGrid}.
 *
 * @stability experimental
 */
export interface PersonGridProps {
  people: PersonListItem[];
  /** Opens a person. */
  onPersonClick: (person: PersonListItem) => void;
  loading?: boolean;
  emptyMessage?: string;
  /** Marks or unmarks a person as a favorite. */
  onToggleFavorite?: (person: PersonListItem) => void;
  /** Hides a person. */
  onHide?: (person: PersonListItem) => void;
  /** Restores a hidden person. */
  onUnhide?: (person: PersonListItem) => void;
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  /** Adds or removes a person from the selection. */
  onToggleSelect?: (person: PersonListItem) => void;
}

/**
 * A responsive grid of {@link PersonCard}s.
 *
 * @param props - the people and the callbacks.
 * @returns the grid.
 *
 * @stability experimental
 */
export function PersonGrid({
  people,
  onPersonClick,
  loading,
  emptyMessage,
  onToggleFavorite,
  onHide,
  onUnhide,
  selectionMode,
  selectedIds,
  onToggleSelect,
}: PersonGridProps) {
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
          <PersonCard
            person={person}
            onClick={onPersonClick}
            onToggleFavorite={onToggleFavorite}
            onHide={onHide}
            onUnhide={onUnhide}
            selectionMode={selectionMode}
            selected={selectedIds?.has(person.id)}
            onToggleSelect={onToggleSelect}
          />
        </Grid>
      ))}
    </Grid>
  );
}
