import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Alert,
  CircularProgress,
  Divider,
  Typography,
} from '@mui/material';
import { Label as LabelIcon } from '@mui/icons-material';
import { TagAutocomplete } from './TagAutocomplete';
import { bulkTags } from '../../services/media';

interface BulkTagsDialogProps {
  open: boolean;
  onClose: () => void;
  circleId: string;
  ids: string[];
  onSuccess: (message: string) => void;
}

export function BulkTagsDialog({
  open,
  onClose,
  circleId,
  ids,
  onSuccess,
}: BulkTagsDialogProps) {
  const [tagsToAdd, setTagsToAdd] = useState<string[]>([]);
  const [tagsToRemove, setTagsToRemove] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApply = async () => {
    if (tagsToAdd.length === 0 && tagsToRemove.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const result = await bulkTags({
        circleId,
        ids,
        add: tagsToAdd.length > 0 ? tagsToAdd : undefined,
        remove: tagsToRemove.length > 0 ? tagsToRemove : undefined,
      });
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} tag${result.added !== 1 ? 's' : ''} added`);
      if (result.removed > 0) parts.push(`${result.removed} tag${result.removed !== 1 ? 's' : ''} removed`);
      onSuccess(parts.join(', ') || 'No changes');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update tags');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setTagsToAdd([]);
    setTagsToRemove([]);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
          <LabelIcon />
          <span>Edit Tags for {ids.length} item{ids.length !== 1 ? 's' : ''}</span>
        </Stack>
      </DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Stack spacing={3}>
          <div>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Tags to Add
            </Typography>
            <TagAutocomplete
              label="Add tags"
              value={tagsToAdd}
              onChange={setTagsToAdd}
              circleId={circleId}
              disabled={saving}
              placeholder="Select or type tags to add"
            />
          </div>
          <Divider />
          <div>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Tags to Remove
            </Typography>
            <TagAutocomplete
              label="Remove tags"
              value={tagsToRemove}
              onChange={setTagsToRemove}
              circleId={circleId}
              disabled={saving}
              placeholder="Select or type tags to remove"
            />
          </div>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={saving}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => void handleApply()}
          disabled={(tagsToAdd.length === 0 && tagsToRemove.length === 0) || saving}
          startIcon={saving ? <CircularProgress size={14} /> : undefined}
        >
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}
