/**
 * The single-person picker of the `assign_person` and `remove_person` workflow actions:
 * the host's `workflows.personSelect` slot of the packaged workflow builder, because
 * people belong to the people slice, which has not moved into
 * `@marinoscar/memoriahub-web` yet.
 */
import { Autocomplete, TextField } from '@mui/material';
import type { WorkflowPersonSelectSlotProps } from '@marinoscar/memoriahub-web/workflows/ui';
import { usePeople } from '@marinoscar/memoriahub-web/people/headless';

export function WorkflowPersonSelect({ circleId, value, onChange }: WorkflowPersonSelectSlotProps) {
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
