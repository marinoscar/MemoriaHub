// The people carousel of the search page's explore view: the labelled people of the
// active library, favourites first, then by face count.
import { Box, Typography } from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import { useNavigate } from 'react-router-dom';
import { ExploreCarousel } from '../../../media/ui/index.js';
import { usePeople } from '../../headless/index.js';
import type { PersonListItem } from '../../headless/index.js';
import { PersonAvatar } from './PersonAvatar.js';

/**
 * The props of {@link SearchPeopleExplore}.
 *
 * @stability experimental
 */
export interface SearchPeopleExploreProps {
  /** The owner scope id whose people are shown. */
  circleId: string;
}

function renderPersonTile(person: PersonListItem, navigate: ReturnType<typeof useNavigate>) {
  return (
    <Box
      onClick={() => navigate(`/media?personId=${person.id}`)}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.5,
        cursor: 'pointer',
        flexShrink: 0,
        width: 80,
        '&:hover': { opacity: 0.8 },
      }}
      role="button"
      aria-label={`View photos of ${person.name}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ')
          navigate(`/media?personId=${person.id}`);
      }}
    >
      <PersonAvatar person={person} size={64} />
      <Typography
        variant="caption"
        align="center"
        sx={{
          maxWidth: 76,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'block',
        }}
      >
        {person.name}
      </Typography>
    </Box>
  );
}

/**
 * The people carousel of the Search page's explore view: labelled people, favourites first, then by face count.
 *
 * @stability experimental
 */
export function SearchPeopleExplore({ circleId }: SearchPeopleExploreProps) {
  const navigate = useNavigate();
  const { data: peopleData, loading: peopleLoading } = usePeople(circleId);

  // Sort people: favorites first, then by face count descending.
  const people = [...(peopleData?.items ?? [])]
    .filter((p) => p.name != null)
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) || b.faceCount - a.faceCount,
    );

  if (!peopleLoading && people.length === 0) return null;

  return (
    <ExploreCarousel<PersonListItem>
      title="People"
      icon={<PersonIcon sx={{ color: 'text.secondary' }} />}
      loading={peopleLoading}
      items={people}
      itemWidth={80}
      gap={12}
      keyOf={(p) => p.id}
      renderItem={(p) => renderPersonTile(p, navigate)}
      viewAllLabel="View all"
      onViewAll={() => navigate('/people')}
    />
  );
}
