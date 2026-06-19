import type { SyntheticEvent } from 'react';
import {
  Box,
  Typography,
  Autocomplete,
  TextField,
  ToggleButtonGroup,
  ToggleButton,
  Chip,
} from '@mui/material';
import type {
  AutocompleteRenderValueGetItemProps,
  AutocompleteOwnerState,
  AutocompleteRenderValue,
} from '@mui/material/Autocomplete';
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

  const handleAutocompleteChange = (
    _: SyntheticEvent,
    newValue: (string | PersonListItem)[],
  ) => {
    const people = newValue.filter((v): v is PersonListItem => typeof v !== 'string');
    onChange({ ids: people.map((p) => p.id), mode: value.mode });
  };

  const handleToggleChange = (_: React.MouseEvent<HTMLElement>, newMode: string | null) => {
    if (newMode !== null) {
      onChange({ ids: value.ids, mode: newMode as 'all' | 'any' });
    }
  };

  const renderValue = (
    tagValue: AutocompleteRenderValue<PersonListItem, true, true>,
    getItemProps: AutocompleteRenderValueGetItemProps<true>,
    _ownerState: AutocompleteOwnerState<PersonListItem, true, false, true>,
  ) =>
    (tagValue as PersonListItem[]).map((option: PersonListItem, index: number) => {
      const { key, ...chipProps } = getItemProps({ index });
      return (
        <Chip
          key={key}
          {...chipProps}
          label={option.name ?? option.id.slice(0, 8)}
          size="small"
          avatar={<PersonAvatar person={option} size={24} />}
        />
      );
    });

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        gap: 1,
        alignItems: { xs: 'stretch', sm: 'flex-start' },
      }}
    >
      <Autocomplete<PersonListItem, true, false, true>
        multiple
        freeSolo
        options={options}
        value={selectedOptions}
        onChange={handleAutocompleteChange}
        getOptionLabel={(option) =>
          typeof option === 'string' ? option : (option.name ?? option.id.slice(0, 8))
        }
        isOptionEqualToValue={(option, val) =>
          typeof option === 'string' || typeof val === 'string'
            ? option === val
            : option.id === val.id
        }
        renderOption={(props, option) => {
          if (typeof option === 'string') return null;
          return (
            <Box component="li" {...props} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <PersonAvatar person={option} size={28} />
              <Typography variant="body2">{option.name ?? option.id.slice(0, 8)}</Typography>
            </Box>
          );
        }}
        renderValue={renderValue}
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
