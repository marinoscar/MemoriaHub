import {
  Card,
  CardActionArea,
  CardContent,
  Typography,
  Box,
  Chip,
} from '@mui/material';
import { PersonAvatar } from './PersonAvatar';
import type { PersonListItem } from '../../services/face';

interface PersonCardProps {
  person: PersonListItem;
  onClick: (person: PersonListItem) => void;
}

export function PersonCard({ person, onClick }: PersonCardProps) {
  const displayName = person.name ?? 'Unlabeled';

  return (
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
  );
}
