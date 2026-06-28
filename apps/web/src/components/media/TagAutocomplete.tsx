import { useState, useEffect, type SyntheticEvent, type EventHandler } from 'react';
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
  /** Tag names that cannot be removed by the user (rendered with lock styling). */
  lockedNames?: string[];
}

export function TagAutocomplete({
  label,
  value,
  onChange,
  circleId,
  disabled,
  placeholder,
  lockedNames,
}: TagAutocompleteProps) {
  const [options, setOptions] = useState<string[]>([]);

  useEffect(() => {
    listTags(circleId)
      .then((tags) => setOptions(tags.map((t) => t.name)))
      .catch(() => setOptions([]));
  }, [circleId]);

  const handleChange = (_event: SyntheticEvent, newValue: (string | string)[]) => {
    const next = newValue as string[];
    // Prevent locked names from being removed
    if (lockedNames && lockedNames.length > 0) {
      const currentLocked = value.filter((v) => lockedNames.includes(v));
      const missingLocked = currentLocked.filter((l) => !next.includes(l));
      if (missingLocked.length > 0) {
        onChange([...next, ...missingLocked]);
        return;
      }
    }
    onChange(next);
  };

  const renderValue = (
    tagValue: AutocompleteRenderValue<string, true, true>,
    getItemProps: AutocompleteRenderValueGetItemProps<true>,
    _ownerState: AutocompleteOwnerState<string, true, false, true>,
  ) =>
    (tagValue as string[]).map((option: string, index: number) => {
      const { key, onDelete, ...chipProps } = getItemProps({ index }) as ReturnType<AutocompleteRenderValueGetItemProps<true>> & { onDelete?: EventHandler<SyntheticEvent> };
      const isLocked = lockedNames?.includes(option) ?? false;
      return (
        <Chip
          key={key}
          label={option}
          size="small"
          color={isLocked ? 'secondary' : 'default'}
          {...chipProps}
          {...(isLocked ? {} : { onDelete })}
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
