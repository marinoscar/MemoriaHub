import { Divider, ListItemIcon, ListItemText, Menu, MenuItem } from '@mui/material';
import {
  DeleteOutlined as DeleteIcon,
  Favorite as FavoriteIcon,
  FavoriteBorder as FavoriteBorderIcon,
  IosShare as IosShareIcon,
  PhotoAlbum as PhotoAlbumIcon,
  PlayArrow as PlayArrowIcon,
  VisibilityOff as VisibilityOffIcon,
} from '@mui/icons-material';

export interface MemoryActionMenuProps {
  anchorEl: HTMLElement | null;
  /** Alternative anchor for the touch long-press path. */
  anchorPosition?: { top: number; left: number } | null;
  open: boolean;
  favorited: boolean;
  /** Delete is collaborator-only; a viewer never sees the item at all. */
  canDelete: boolean;
  onClose: () => void;
  onPlay: () => void;
  onToggleFavorite: () => void;
  onHide: () => void;
  onSaveAsAlbum: () => void;
  /**
   * Share hand-off (issue #313). Optional so a surface that has not wired the
   * album-chaining dialogs simply omits the item rather than showing one that
   * does nothing.
   */
  onShare?: () => void;
  onDelete: () => void;
}

/**
 * Card overflow menu, shared by the kebab (pointer) and the long-press (touch)
 * entry points — one component so the two can never offer different actions.
 *
 * Delete is omitted entirely rather than disabled for a viewer: a disabled
 * destructive item advertises a capability the user does not have and invites
 * them to go looking for the permission. The API enforces the same rule
 * (`media:write` + the collaborator circle role), so this is presentation of an
 * authorization decision, never the decision itself.
 */
export function MemoryActionMenu({
  anchorEl,
  anchorPosition,
  open,
  favorited,
  canDelete,
  onClose,
  onPlay,
  onToggleFavorite,
  onHide,
  onSaveAsAlbum,
  onShare,
  onDelete,
}: MemoryActionMenuProps) {
  return (
    <Menu
      anchorEl={anchorPosition ? undefined : anchorEl}
      anchorReference={anchorPosition ? 'anchorPosition' : 'anchorEl'}
      anchorPosition={anchorPosition ?? undefined}
      open={open}
      onClose={onClose}
      slotProps={{ list: { dense: true } }}
    >
      <MenuItem onClick={onPlay}>
        <ListItemIcon>
          <PlayArrowIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Play</ListItemText>
      </MenuItem>

      <MenuItem onClick={onToggleFavorite}>
        <ListItemIcon>
          {favorited ? (
            <FavoriteIcon fontSize="small" color="error" />
          ) : (
            <FavoriteBorderIcon fontSize="small" />
          )}
        </ListItemIcon>
        <ListItemText>{favorited ? 'Remove favorite' : 'Favorite'}</ListItemText>
      </MenuItem>

      <MenuItem onClick={onHide}>
        <ListItemIcon>
          <VisibilityOffIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Hide for me</ListItemText>
      </MenuItem>

      <MenuItem onClick={onSaveAsAlbum}>
        <ListItemIcon>
          <PhotoAlbumIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Save as album</ListItemText>
      </MenuItem>

      {onShare && (
        <MenuItem onClick={onShare}>
          <ListItemIcon>
            <IosShareIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Share"
            secondary="Creates a shareable album"
            slotProps={{ secondary: { variant: 'caption' } }}
          />
        </MenuItem>
      )}

      {canDelete && [
        <Divider key="divider" />,
        <MenuItem key="delete" onClick={onDelete}>
          <ListItemIcon>
            <DeleteIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText
            primary="Delete"
            slotProps={{ primary: { color: 'error' } }}
          />
        </MenuItem>,
      ]}
    </Menu>
  );
}
