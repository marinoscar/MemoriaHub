import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  CardContent,
  Typography,
  Button,
  Box,
  Checkbox,
  FormControlLabel,
  FormGroup,
  Stack,
  CircularProgress,
  Alert,
  Divider,
} from '@mui/material';
import { getSearchFields } from '../../services/search';
import type { SearchField } from '../../services/search';
import type { UserSettings } from '../../types';

interface SearchFieldsSettingsProps {
  settings: UserSettings;
  updateSettings: (updates: Partial<UserSettings>) => Promise<void>;
  disabled?: boolean;
}

export function SearchFieldsSettings({
  settings,
  updateSettings,
  disabled = false,
}: SearchFieldsSettingsProps) {
  const [allFields, setAllFields] = useState<SearchField[]>([]);
  const [isLoadingFields, setIsLoadingFields] = useState(true);
  const [fieldsError, setFieldsError] = useState<string | null>(null);

  // selected keys: undefined/empty means "all visible"
  const savedKeys = settings.search?.visibleFields ?? [];

  // If savedKeys is empty we treat everything as selected
  const computeInitialSelected = useCallback(
    (fields: SearchField[]): Set<string> => {
      if (savedKeys.length === 0) {
        return new Set(fields.map((f) => f.key));
      }
      return new Set(savedKeys);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.search?.visibleFields],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Load available fields once
  useEffect(() => {
    let cancelled = false;
    setIsLoadingFields(true);
    setFieldsError(null);
    getSearchFields()
      .then((fields) => {
        if (cancelled) return;
        setAllFields(fields);
        setSelected(computeInitialSelected(fields));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFieldsError(err instanceof Error ? err.message : 'Failed to load search fields');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingFields(false);
      });
    return () => {
      cancelled = true;
    };
  }, [computeInitialSelected]);

  // Recompute initial selection when settings change (e.g. after save)
  useEffect(() => {
    if (allFields.length === 0) return;
    setSelected(computeInitialSelected(allFields));
    setHasChanges(false);
  }, [settings.search?.visibleFields, allFields, computeInitialSelected]);

  const toggle = (key: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
    setHasChanges(true);
    setSaveSuccess(false);
  };

  const selectAll = () => {
    setSelected(new Set(allFields.map((f) => f.key)));
    setHasChanges(true);
    setSaveSuccess(false);
  };

  const clearAll = () => {
    setSelected(new Set());
    setHasChanges(true);
    setSaveSuccess(false);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      // If all fields selected, persist [] (meaning "show all" = default).
      // If none selected, also persist [] (show all fallback).
      const allSelected =
        selected.size === allFields.length || selected.size === 0;
      const visibleFields = allSelected ? [] : Array.from(selected);
      await updateSettings({ search: { visibleFields } });
      setSaveSuccess(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Search Fields
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Choose which filter fields appear in the Advanced Search tab. Deselecting all shows
          every field (default behaviour).
        </Typography>

        {isLoadingFields && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={28} />
          </Box>
        )}

        {fieldsError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {fieldsError}
          </Alert>
        )}

        {!isLoadingFields && !fieldsError && (
          <>
            {/* Bulk helpers */}
            <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
              <Button
                size="small"
                variant="outlined"
                onClick={selectAll}
                disabled={disabled || isSaving}
                sx={{ minHeight: 44 }}
              >
                Select all
              </Button>
              <Button
                size="small"
                variant="outlined"
                onClick={clearAll}
                disabled={disabled || isSaving}
                sx={{ minHeight: 44 }}
              >
                Clear all
              </Button>
            </Stack>

            <Divider sx={{ my: 1.5 }} />

            <FormGroup>
              {allFields.map((field) => (
                <FormControlLabel
                  key={field.key}
                  control={
                    <Checkbox
                      checked={selected.has(field.key)}
                      onChange={(e) => toggle(field.key, e.target.checked)}
                      disabled={disabled || isSaving}
                      size="medium"
                      sx={{ py: 0.75 }}
                    />
                  }
                  label={
                    <Box>
                      <Typography variant="body2" component="span">
                        {field.label}
                      </Typography>
                      {field.description && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ ml: 1 }}
                          component="span"
                        >
                          {field.description}
                        </Typography>
                      )}
                    </Box>
                  }
                  sx={{ minHeight: 44, alignItems: 'center' }}
                />
              ))}
            </FormGroup>

            {saveError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {saveError}
              </Alert>
            )}

            {saveSuccess && (
              <Alert severity="success" sx={{ mt: 2 }}>
                Search field preferences saved.
              </Alert>
            )}

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
              <Button
                variant="contained"
                onClick={() => void handleSave()}
                disabled={disabled || !hasChanges || isSaving}
                sx={{ minHeight: 44 }}
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </Button>
            </Box>
          </>
        )}
      </CardContent>
    </Card>
  );
}
