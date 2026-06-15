import { useState, useEffect, type SyntheticEvent } from 'react';
import { Autocomplete, TextField, Chip } from '@mui/material';
import type {
  AutocompleteRenderValueGetItemProps,
  AutocompleteOwnerState,
  AutocompleteRenderValue,
} from '@mui/material/Autocomplete';
import { listTags } from '../../services/media';

interface TagAutocompleteProps {
  label: string;
  value: string[];
  onChange: (tags: string[]) => void;
  circleId?: string;
  disabled?: boolean;
  placeholder?: string;
}

export function TagAutocomplete({
  label,
  value,
  onChange,
  circleId,
  disabled,
  placeholder,
}: TagAutocompleteProps) {
  const [options, setOptions] = useState<string[]>([]);

  useEffect(() => {
    listTags(circleId)
      .then((tags) => setOptions(tags.map((t) => t.name)))
      .catch(() => setOptions([]));
  }, [circleId]);

  const handleChange = (_event: SyntheticEvent, newValue: (string | string)[]) => {
    onChange(newValue as string[]);
  };

  const renderValue = (
    tagValue: AutocompleteRenderValue<string, true, true>,
    getItemProps: AutocompleteRenderValueGetItemProps<true>,
    _ownerState: AutocompleteOwnerState<string, true, false, true>,
  ) =>
    (tagValue as string[]).map((option: string, index: number) => {
      const { key, ...chipProps } = getItemProps({ index });
      return (
        <Chip
          key={key}
          label={option}
          size="small"
          {...chipProps}
        />
      );
    });

  return (
    <Autocomplete<string, true, false, true>
      multiple
      freeSolo
      options={options}
      value={value}
      onChange={handleChange}
      disabled={disabled}
      renderValue={renderValue}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder ?? 'Type or select tags'}
          size="small"
        />
      )}
    />
  );
}
