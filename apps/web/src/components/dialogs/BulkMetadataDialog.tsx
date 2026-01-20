import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControlLabel,
  Checkbox,
  Stack,
  Typography,
  Box,
} from '@mui/material';

interface BulkMetadataDialogProps {
  /** Whether dialog is open */
  open: boolean;
  /** Number of selected items */
  selectedCount: number;
  /** Handler to close dialog */
  onClose: () => void;
  /** Handler to apply changes */
  onApply: (metadata: BulkMetadataUpdate) => void;
}

export interface BulkMetadataUpdate {
  capturedAtUtc?: string;
  latitude?: number | null;
  longitude?: number | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  locationName?: string | null;
}

/**
 * Dialog for editing metadata of multiple selected items
 * Allows user to choose which fields to update
 */
export function BulkMetadataDialog({
  open,
  selectedCount,
  onClose,
  onApply,
}: BulkMetadataDialogProps) {
  // Field enable toggles
  const [enabledFields, setEnabledFields] = useState({
    capturedAt: false,
    latitude: false,
    longitude: false,
    country: false,
    state: false,
    city: false,
    locationName: false,
  });

  // Field values
  const [values, setValues] = useState({
    capturedAtUtc: '',
    latitude: '',
    longitude: '',
    country: '',
    state: '',
    city: '',
    locationName: '',
  });

  const handleToggleField = (field: keyof typeof enabledFields) => {
    setEnabledFields((prev) => ({ ...prev, [field]: !prev[field] }));
  };

  const handleValueChange = (field: keyof typeof values, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
  };

  const handleApply = () => {
    const metadata: BulkMetadataUpdate = {};

    if (enabledFields.capturedAt && values.capturedAtUtc) {
      metadata.capturedAtUtc = values.capturedAtUtc;
    }

    if (enabledFields.latitude) {
      const lat = parseFloat(values.latitude);
      metadata.latitude = isNaN(lat) ? null : lat;
    }

    if (enabledFields.longitude) {
      const lng = parseFloat(values.longitude);
      metadata.longitude = isNaN(lng) ? null : lng;
    }

    if (enabledFields.country) {
      metadata.country = values.country || null;
    }

    if (enabledFields.state) {
      metadata.state = values.state || null;
    }

    if (enabledFields.city) {
      metadata.city = values.city || null;
    }

    if (enabledFields.locationName) {
      metadata.locationName = values.locationName || null;
    }

    onApply(metadata);
    handleClose();
  };

  const handleClose = () => {
    // Reset state on close
    setEnabledFields({
      capturedAt: false,
      latitude: false,
      longitude: false,
      country: false,
      state: false,
      city: false,
      locationName: false,
    });
    setValues({
      capturedAtUtc: '',
      latitude: '',
      longitude: '',
      country: '',
      state: '',
      city: '',
      locationName: '',
    });
    onClose();
  };

  const hasEnabledFields = Object.values(enabledFields).some(Boolean);

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit Metadata</DialogTitle>

      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Update metadata for {selectedCount} selected {selectedCount === 1 ? 'item' : 'items'}. Check the fields you want to update.
        </Typography>

        <Stack spacing={2}>
          {/* Captured At */}
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  checked={enabledFields.capturedAt}
                  onChange={() => handleToggleField('capturedAt')}
                  size="small"
                />
              }
              label="Captured At"
            />
            <TextField
              fullWidth
              type="datetime-local"
              size="small"
              disabled={!enabledFields.capturedAt}
              value={values.capturedAtUtc}
              onChange={(e) => handleValueChange('capturedAtUtc', e.target.value)}
              sx={{ mt: 1 }}
              label="Captured At"
            />
          </Box>

          {/* Latitude */}
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  checked={enabledFields.latitude}
                  onChange={() => handleToggleField('latitude')}
                  size="small"
                />
              }
              label="Latitude"
            />
            <TextField
              fullWidth
              type="number"
              size="small"
              label="Latitude"
              placeholder="-90 to 90"
              disabled={!enabledFields.latitude}
              value={values.latitude}
              onChange={(e) => handleValueChange('latitude', e.target.value)}
              inputProps={{ min: -90, max: 90, step: 0.000001 }}
              sx={{ mt: 1 }}
            />
          </Box>

          {/* Longitude */}
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  checked={enabledFields.longitude}
                  onChange={() => handleToggleField('longitude')}
                  size="small"
                />
              }
              label="Longitude"
            />
            <TextField
              fullWidth
              type="number"
              size="small"
              label="Longitude"
              placeholder="-180 to 180"
              disabled={!enabledFields.longitude}
              value={values.longitude}
              onChange={(e) => handleValueChange('longitude', e.target.value)}
              inputProps={{ min: -180, max: 180, step: 0.000001 }}
              sx={{ mt: 1 }}
            />
          </Box>

          {/* Country */}
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  checked={enabledFields.country}
                  onChange={() => handleToggleField('country')}
                  size="small"
                />
              }
              label="Country"
            />
            <TextField
              fullWidth
              size="small"
              label="Country"
              placeholder="e.g., United States"
              disabled={!enabledFields.country}
              value={values.country}
              onChange={(e) => handleValueChange('country', e.target.value)}
              sx={{ mt: 1 }}
            />
          </Box>

          {/* State */}
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  checked={enabledFields.state}
                  onChange={() => handleToggleField('state')}
                  size="small"
                />
              }
              label="State"
            />
            <TextField
              fullWidth
              size="small"
              label="State"
              placeholder="e.g., California"
              disabled={!enabledFields.state}
              value={values.state}
              onChange={(e) => handleValueChange('state', e.target.value)}
              sx={{ mt: 1 }}
            />
          </Box>

          {/* City */}
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  checked={enabledFields.city}
                  onChange={() => handleToggleField('city')}
                  size="small"
                />
              }
              label="City"
            />
            <TextField
              fullWidth
              size="small"
              label="City"
              placeholder="e.g., San Francisco"
              disabled={!enabledFields.city}
              value={values.city}
              onChange={(e) => handleValueChange('city', e.target.value)}
              sx={{ mt: 1 }}
            />
          </Box>

          {/* Location Name */}
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  checked={enabledFields.locationName}
                  onChange={() => handleToggleField('locationName')}
                  size="small"
                />
              }
              label="Location Name"
            />
            <TextField
              fullWidth
              size="small"
              label="Location Name"
              placeholder="e.g., Golden Gate Park"
              disabled={!enabledFields.locationName}
              value={values.locationName}
              onChange={(e) => handleValueChange('locationName', e.target.value)}
              sx={{ mt: 1 }}
            />
          </Box>
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleApply}
          disabled={!hasEnabledFields}
        >
          Apply to {selectedCount} {selectedCount === 1 ? 'Item' : 'Items'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
