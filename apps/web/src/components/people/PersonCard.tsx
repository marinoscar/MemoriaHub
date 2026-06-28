import {
  Card,
  CardActionArea,
  CardContent,
  Typography,
  Box,
  Chip,
  IconButton,
  Tooltip,
  Checkbox,
} from '@mui/material';
import {
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  VisibilityOff as VisibilityOffIcon,
  Visibility as VisibilityIcon,
} from '@mui/icons-material';
import { PersonAvatar } from './PersonAvatar';
import type { PersonListItem } from '../../services/face';

interface PersonCardProps {
  person: PersonListItem;
  onClick: (person: PersonListItem) => void;
  onToggleFavorite?: (person: PersonListItem) => void;
  /** Called when the hide icon-button is clicked. If provided, the hide button appears. */
  onHide?: (person: PersonListItem) => void;
  /** Called when the unhide icon-button is clicked. If provided, the unhide button appears instead of hide. */
  onUnhide?: (person: PersonListItem) => void;
  /** When true, the card shows a selection checkbox for bulk-selection mode. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (person: PersonListItem) => void;
}

export function PersonCard({
  person,
  onClick,
  onToggleFavorite,
  onHide,
  onUnhide,
  selectionMode,
  selected,
  onToggleSelect,
}: PersonCardProps) {
  const displayName = person.name ?? 'Unlabeled';

  return (
    <Box sx={{ position: 'relative', height: '100%' }}>
      <Card
        variant="outlined"
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          outline: selected ? '2px solid' : undefined,
          outlineColor: selected ? 'primary.main' : undefined,
        }}
      >
        <CardActionArea
          onClick={() => {
            if (selectionMode && onToggleSelect) {
              onToggleSelect(person);
            } else {
              onClick(person);
            }
          }}
          sx={{ flexGrow: 1 }}
        >
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

      {/* Selection checkbox — top-left, shown in selection mode */}
      {selectionMode && (
        <Checkbox
          size="small"
          checked={selected ?? false}
          onChange={() => onToggleSelect?.(person)}
          onClick={(e) => e.stopPropagation()}
          sx={{
            position: 'absolute',
            top: 2,
            left: 2,
            zIndex: 3,
            p: 0.25,
            backgroundColor: 'rgba(255,255,255,0.85)',
            borderRadius: 1,
            '&:hover': { backgroundColor: 'rgba(255,255,255,0.95)' },
          }}
        />
      )}

      {/* Favorite toggle — top-right */}
      {onToggleFavorite && !selectionMode && (
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

      {/* Hide button — bottom-right (only when not in selection mode) */}
      {onHide && !selectionMode && (
        <Tooltip title="Hide this person (removes from People page; photos stay)">
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onHide(person);
            }}
            aria-label="Hide person"
            sx={{
              position: 'absolute',
              bottom: 4,
              right: 4,
              zIndex: 2,
              minWidth: 36,
              minHeight: 36,
              color: 'text.secondary',
              backgroundColor: 'rgba(255,255,255,0.75)',
              '&:hover': { backgroundColor: 'rgba(255,255,255,0.95)', color: 'warning.main' },
            }}
          >
            <VisibilityOffIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}

      {/* Unhide button — bottom-right (shown in hidden view instead of hide) */}
      {onUnhide && !selectionMode && (
        <Tooltip title="Unhide this person">
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onUnhide(person);
            }}
            aria-label="Unhide person"
            sx={{
              position: 'absolute',
              bottom: 4,
              right: 4,
              zIndex: 2,
              minWidth: 36,
              minHeight: 36,
              color: 'primary.main',
              backgroundColor: 'rgba(255,255,255,0.75)',
              '&:hover': { backgroundColor: 'rgba(255,255,255,0.95)' },
            }}
          >
            <VisibilityIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}
