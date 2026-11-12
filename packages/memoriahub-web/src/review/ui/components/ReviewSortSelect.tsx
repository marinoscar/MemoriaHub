import { FormControl, InputLabel, MenuItem, Select } from '@mui/material';

/**
 * One sort choice of a review queue's sort select.
 *
 * @stability experimental
 */
export interface ReviewSortOption {
  /** Combined `${sortBy}:${sortOrder}` value, e.g. `capturedAt:asc`. */
  value: string;
  label: string;
}

/**
 * The props of {@link ReviewSortSelect}.
 *
 * @stability experimental
 */
export interface ReviewSortSelectProps {
  /** Combined `${sortBy}:${sortOrder}` value of the current selection. */
  value: string;
  /** Called with the chosen sort value. */
  onChange: (sortBy: string, sortOrder: 'asc' | 'desc') => void;
  options: ReviewSortOption[];
  label?: string;
}

/**
 * Compact sort picker shared by the three review-queue pages (bursts,
 * duplicates, location suggestions). Mirrors the combined `sortBy:sortOrder`
 * Select used by the media library so one MUI control drives both fields.
 *
 * @stability experimental
 */
export function ReviewSortSelect({
  value,
  onChange,
  options,
  label = 'Sort by',
}: ReviewSortSelectProps) {
  const labelId = 'review-sort-select-label';

  return (
    <FormControl size="small" sx={{ minWidth: 200 }} data-testid="review-sort-select">
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        labelId={labelId}
        label={label}
        value={value}
        onChange={(e) => {
          const [by, order] = e.target.value.split(':');
          onChange(by, order === 'asc' ? 'asc' : 'desc');
        }}
      >
        {options.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
