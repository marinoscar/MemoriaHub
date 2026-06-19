import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Switch,
  IconButton,
  Divider,
  CircularProgress,
  Link,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  Close as CloseIcon,
  Tune as TuneIcon,
} from '@mui/icons-material';
import { useSearch } from '../../hooks/useSearch';
import { useUserSettings } from '../../hooks/useUserSettings';
import { PersonMultiSelect } from './PersonMultiSelect';
import type { MediaItem } from '../../types/media';
import type { SearchFilters } from '../../services/search';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdvancedSearchDialogProps {
  open: boolean;
  onClose: () => void;
  circleId: string;
  /** Called when search results arrive; parent renders them */
  onResults: (items: MediaItem[], totalItems: number) => void;
}

// ---------------------------------------------------------------------------
// AdvancedSearchDialog
// ---------------------------------------------------------------------------

export function AdvancedSearchDialog({
  open,
  onClose,
  circleId,
  onResults,
}: AdvancedSearchDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));

  const { settings } = useUserSettings();
  const { fields, isLoadingFields, isSearching, error, fetchFields, search } = useSearch();

  const [filters, setFilters] = useState<Record<string, unknown>>({});

  // Derive visible fields from user preferences
  const visibleFields = settings?.search?.visibleFields ?? [];
  const fieldsToRender =
    visibleFields.length > 0
      ? fields.filter((f) => visibleFields.includes(f.key))
      : fields;

  useEffect(() => {
    if (open) {
      void fetchFields();
    }
  }, [open, fetchFields]);

  const setFilter = useCallback((key: string, value: unknown) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleClearAll = () => {
    setFilters({});
  };

  const handleSearch = async () => {
    if (!circleId) return;
    try {
      // Clean up empty people filter
      const cleanedFilters: SearchFilters = { ...filters };
      const peopleVal = cleanedFilters['people'] as { ids: string[]; mode: 'all' | 'any' } | undefined;
      if (!peopleVal || peopleVal.ids.length === 0) {
        delete cleanedFilters['people'];
      }

      const result = await search({
        circleId,
        filters: cleanedFilters,
        page: 1,
        pageSize: 20,
      });
      onResults(result.items, result.meta.totalItems);
      onClose();
    } catch {
      // error is surfaced via useSearch's `error` state
    }
  };

  const isAiNotConfigured = error?.toLowerCase().includes('not configured') ?? false;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      maxWidth="sm"
      fullWidth
      aria-labelledby="advanced-search-title"
    >
      <DialogTitle
        id="advanced-search-title"
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TuneIcon />
          <Typography variant="h6" component="span">
            Filter options
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Tooltip title="Customize visible fields">
            <Link
              href="/settings#search-fields"
              underline="hover"
              variant="caption"
              color="text.secondary"
              sx={{ cursor: 'pointer' }}
            >
              Customize fields
            </Link>
          </Tooltip>
          <IconButton size="small" onClick={onClose} aria-label="Close filter options">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ pt: 2 }}>
        {isLoadingFields ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {fieldsToRender.map((field) => {
              if (field.type === 'date-range') {
                return (
                  <Box key={field.key} sx={{ display: 'flex', gap: 1, flexDirection: { xs: 'column', sm: 'row' } }}>
                    <TextField
                      label={`${field.label} from`}
                      type="date"
                      size="small"
                      fullWidth
                      value={(filters[`${field.key}_from`] as string) ?? ''}
                      onChange={(e) => setFilter(`${field.key}_from`, e.target.value)}
                      slotProps={{ inputLabel: { shrink: true } }}
                    />
                    <TextField
                      label={`${field.label} to`}
                      type="date"
                      size="small"
                      fullWidth
                      value={(filters[`${field.key}_to`] as string) ?? ''}
                      onChange={(e) => setFilter(`${field.key}_to`, e.target.value)}
                      slotProps={{ inputLabel: { shrink: true } }}
                    />
                  </Box>
                );
              }

              if (field.type === 'enum') {
                return (
                  <FormControl key={field.key} size="small" fullWidth>
                    <InputLabel>{field.label}</InputLabel>
                    <Select
                      label={field.label}
                      value={(filters[field.key] as string) ?? ''}
                      onChange={(e) => setFilter(field.key, e.target.value)}
                    >
                      <MenuItem value="">All</MenuItem>
                      {field.enumValues?.map((v) => (
                        <MenuItem key={v} value={v}>
                          {v}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                );
              }

              if (field.type === 'boolean') {
                return (
                  <FormControlLabel
                    key={field.key}
                    control={
                      <Switch
                        checked={(filters[field.key] as boolean) ?? false}
                        onChange={(e) => setFilter(field.key, e.target.checked)}
                        size="small"
                      />
                    }
                    label={field.label}
                  />
                );
              }

              if (field.type === 'person-set') {
                const personValue = (filters[field.key] as { ids: string[]; mode: 'all' | 'any' } | undefined)
                  ?? { ids: [], mode: 'all' as const };
                return (
                  <Box key={field.key}>
                    <PersonMultiSelect
                      circleId={circleId}
                      value={personValue}
                      onChange={(next) => setFilter(field.key, next)}
                      label={field.label}
                    />
                  </Box>
                );
              }

              // 'string' | 'geo'
              return (
                <TextField
                  key={field.key}
                  label={field.label}
                  size="small"
                  fullWidth
                  value={(filters[field.key] as string) ?? ''}
                  onChange={(e) => setFilter(field.key, e.target.value)}
                />
              );
            })}

            {/* Error feedback */}
            {error && !isAiNotConfigured && (
              <Typography variant="body2" color="error">
                {error}
              </Typography>
            )}
            {isAiNotConfigured && (
              <Typography variant="body2" color="warning.main">
                AI search is not configured. Admins can enable it in{' '}
                <Link href="/admin/ai-settings" underline="hover">
                  AI Settings
                </Link>
                .
              </Typography>
            )}
          </Box>
        )}
      </DialogContent>

      <Divider />

      <DialogActions sx={{ px: 3, py: 2, justifyContent: 'space-between' }}>
        <Button
          variant="text"
          onClick={handleClearAll}
          disabled={isLoadingFields || isSearching}
          sx={{ minHeight: 44 }}
        >
          Clear all
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleSearch()}
          disabled={!circleId || isLoadingFields || isSearching}
          startIcon={isSearching ? <CircularProgress size={16} /> : undefined}
          sx={{ minHeight: 44 }}
        >
          Search
        </Button>
      </DialogActions>
    </Dialog>
  );
}
