import {
  Card,
  CardActionArea,
  CardContent,
  Typography,
  Box,
  Avatar,
  Chip,
} from '@mui/material';
import { Person as PersonIcon } from '@mui/icons-material';
import { FaceCrop } from './FaceCrop';
import type { PersonListItem } from '../../services/face';

interface PersonCardProps {
  person: PersonListItem;
  imageUrl?: string;      // resolved thumbnail URL for the cover face's media item
  onClick: (person: PersonListItem) => void;
}

export function PersonCard({ person, imageUrl, onClick }: PersonCardProps) {
  const displayName = person.name ?? 'Unlabeled';

  return (
    <Card
      variant="outlined"
      sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <CardActionArea onClick={() => onClick(person)} sx={{ flexGrow: 1 }}>
        <Box sx={{ display: 'flex', justifyContent: 'center', pt: 2 }}>
          {imageUrl && person.coverFace ? (
            <FaceCrop
              imageUrl={imageUrl}
              boundingBox={person.coverFace.boundingBox}
              size={96}
              sx={{ borderRadius: '50%' }}
            />
          ) : (
            <Avatar sx={{ width: 96, height: 96, bgcolor: 'primary.light' }}>
              <PersonIcon sx={{ fontSize: 48 }} />
            </Avatar>
          )}
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
