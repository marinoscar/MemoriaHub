import {
  Box,
  Typography,
  Autocomplete,
  TextField,
  ToggleButtonGroup,
  ToggleButton,
  Chip,
} from '@mui/material';
import { usePeople } from '../../hooks/usePeople';
import { PersonAvatar } from '../people/PersonAvatar';
import type { PersonListItem } from '../../services/face';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersonMultiSelectProps {
  circleId: string;
  value: { ids: string[]; mode: 'all' | 'any' };
  onChange: (next: { ids: string[]; mode: 'all' | 'any' }) => void;
  label?: string;
}

// ---------------------------------------------------------------------------
// PersonMultiSelect
// ---------------------------------------------------------------------------

export function PersonMultiSelect({ circleId, value, onChange, label }: PersonMultiSelectProps) {
  const { data } = usePeople(circleId || null);

  // Only show labeled people (name != null)
  const options: PersonListItem[] = (data?.items ?? []).filter((item) => item.name != null);

  // Derive currently selected PersonListItem objects from ids
  const selectedOptions = value.ids
    .map((id) => options.find((p) => p.id === id))
    .filter((p): p is PersonListItem => p != null);

  const handleAutocompleteChange = (_: React.SyntheticEvent, newValue: PersonListItem[]) => {
    onChange({ ids: newValue.map((p) => p.id), mode: value.mode });
  };

  const handleToggleChange = (_: React.MouseEvent<HTMLElement>, newMode: string | null) => {
    if (newMode !== null) {
      onChange({ ids: value.ids, mode: newMode as 'all' | 'any' });
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        gap: 1,
        alignItems: { xs: 'stretch', sm: 'flex-start' },
      }}
    >
      <Autocomplete
        multiple
        options={options}
        value={selectedOptions}
        onChange={handleAutocompleteChange}
        getOptionLabel={(option) => option.name ?? option.id.slice(0, 8)}
        isOptionEqualToValue={(option, val) => option.id === val.id}
        renderOption={(props, option) => (
          <Box component="li" {...props} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PersonAvatar person={option} size={28} />
            <Typography variant="body2">{option.name ?? option.id.slice(0, 8)}</Typography>
          </Box>
        )}
        renderTags={(tagValue, getTagProps) =>
          tagValue.map((option, index) => {
            const { key, ...tagProps } = getTagProps({ index });
            return (
              <Chip
                key={key}
                {...tagProps}
                label={option.name ?? option.id.slice(0, 8)}
                size="small"
                avatar={<PersonAvatar person={option} size={24} />}
              />
            );
          })
        }
        renderInput={(params) => (
          <TextField {...params} label={label ?? 'People'} size="small" />
        )}
        sx={{ flex: { sm: 1 }, width: { xs: '100%', sm: 'auto' } }}
      />

      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={value.mode}
          onChange={handleToggleChange}
        >
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="any">Any</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
          All = everyone appears together · Any = at least one
        </Typography>
      </Box>
    </Box>
  );
}
