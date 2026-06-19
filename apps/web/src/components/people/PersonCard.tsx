import {
  Card,
  CardActionArea,
  CardContent,
  Typography,
  Box,
  Chip,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  Star as StarIcon,
  StarBorder as StarBorderIcon,
} from '@mui/icons-material';
import { PersonAvatar } from './PersonAvatar';
import type { PersonListItem } from '../../services/face';

interface PersonCardProps {
  person: PersonListItem;
  onClick: (person: PersonListItem) => void;
  onToggleFavorite?: (person: PersonListItem) => void;
}

export function PersonCard({ person, onClick, onToggleFavorite }: PersonCardProps) {
  const displayName = person.name ?? 'Unlabeled';

  return (
    <Box sx={{ position: 'relative', height: '100%' }}>
      <Card
        variant="outlined"
        sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <CardActionArea onClick={() => onClick(person)} sx={{ flexGrow: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'center', pt: 2 }}>
            <PersonAvatar person={person} size={96} />
          </Box>
          <CardContent sx={{ textAlign: 'center', pt: 1 }}>
            <Typography variant="subtitle2" noWrap title={displayName}>
              {displayName}
            </Typography>
            <Chip
              label={`${person.faceCount} photo${person.faceCount !== 1 ? 's' : ''}`}
              size="small"
              sx={{ mt: 0.5 }}
            />
            {person.isUnlabeled && (
              <Chip label="Unlabeled" size="small" color="warning" sx={{ mt: 0.5, ml: 0.5 }} />
            )}
          </CardContent>
        </CardActionArea>
      </Card>

      {onToggleFavorite && (
        <Tooltip title={person.favorite ? 'Remove from favorites' : 'Add to favorites'}>
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(person);
            }}
            aria-label={person.favorite ? 'Remove from favorites' : 'Add to favorites'}
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              zIndex: 2,
              minWidth: 44,
              minHeight: 44,
              color: person.favorite ? 'warning.main' : 'text.secondary',
              backgroundColor: 'rgba(255,255,255,0.75)',
              '&:hover': { backgroundColor: 'rgba(255,255,255,0.95)' },
            }}
          >
            {person.favorite ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}
