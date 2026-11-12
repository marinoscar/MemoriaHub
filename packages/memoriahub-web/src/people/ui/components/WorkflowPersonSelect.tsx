// The single-person picker of the `assign_person` and `remove_person` workflow actions.
import { Autocomplete, TextField } from '@mui/material';
import { usePeople } from '../../headless/index.js';

/**
 * The props of {@link WorkflowPersonSelect}.
 *
 * @stability experimental
 */
export interface WorkflowPersonSelectProps {
  /** The owner scope id whose people are offered. */
  circleId: string;
  /** The chosen person id, `undefined` when none. */
  value: string | undefined;
  /** Called with the chosen person id, `undefined` when cleared. */
  onChange: (personId: string | undefined) => void;
}

/**
 * The single-person picker of the assign_person and remove_person workflow actions.
 *
 * @stability experimental
 */
export function WorkflowPersonSelect({ circleId, value, onChange }: WorkflowPersonSelectProps) {
  const { data: peopleData } = usePeople(circleId);
  const people = (peopleData?.items ?? []).filter((p) => p.name != null);
  const selected = people.find((p) => p.id === value) ?? null;
  return (
    <Autocomplete
      options={people}
      value={selected}
      onChange={(_, v) => onChange(v?.id)}
      getOptionLabel={(p) => p.name ?? p.id.slice(0, 8)}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      size="small"
      sx={{ minWidth: 240, flex: 1 }}
      renderInput={(params) => <TextField {...params} label="Person" />}
    />
  );
}
