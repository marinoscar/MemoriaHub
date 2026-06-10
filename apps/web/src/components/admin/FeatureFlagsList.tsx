import {
  Box,
  Typography,
  Switch,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  TextField,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { useState } from 'react';

interface FeatureFlagsListProps {
  flags: Record<string, boolean>;
  onSave: (flags: Record<string, boolean>) => Promise<void>;
  disabled?: boolean;
}

export function FeatureFlagsList({ flags, onSave, disabled }: FeatureFlagsListProps) {
  const [localFlags, setLocalFlags] = useState<Record<string, boolean>>(flags);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newFlagName, setNewFlagName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const hasChanges = JSON.stringify(localFlags) !== JSON.stringify(flags);

  const handleToggle = (key: string) => {
    setLocalFlags((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleDelete = (key: string) => {
    setLocalFlags((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleAddFlag = () => {
    if (newFlagName && !localFlags.hasOwnProperty(newFlagName)) {
      setLocalFlags((prev) => ({
        ...prev,
        [newFlagName]: false,
      }));
      setNewFlagName('');
      setDialogOpen(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(localFlags);
    } finally {
      setIsSaving(false);
    }
  };

  const flagEntries = Object.entries(localFlags).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h6">Feature Flags</Typography>
        <Button
          startIcon={<AddIcon />}
          onClick={() => setDialogOpen(true)}
          disabled={disabled}
        >
          Add Flag
        </Button>
      </Box>

      {flagEntries.length === 0 ? (
        <Typography color="text.secondary">
          No feature flags configured
        </Typography>
      ) : (
        <List>
          {flagEntries.map(([key, value]) => (
            <ListItem key={key} divider>
              <ListItemText
                primary={key}
                secondary={value ? 'Enabled' : 'Disabled'}
              />
              <ListItemSecondaryAction>
                <Switch
                  checked={value}
                  onChange={() => handleToggle(key)}
                  disabled={disabled}
                />
                <IconButton
                  edge="end"
                  onClick={() => handleDelete(key)}
                  disabled={disabled}
                  sx={{ ml: 1 }}
                >
                  <DeleteIcon />
                </IconButton>
              </ListItemSecondaryAction>
            </ListItem>
          ))}
        </List>
      )}

      <Box sx={{ mt: 3 }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={disabled || !hasChanges || isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Box>

      {/* Add Flag Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>Add Feature Flag</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            label="Flag Name"
            value={newFlagName}
            onChange={(e) => setNewFlagName(e.target.value.replace(/\s/g, '_'))}
            fullWidth
            sx={{ mt: 1 }}
            helperText="Use snake_case or camelCase"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleAddFlag} disabled={!newFlagName}>
            Add
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
