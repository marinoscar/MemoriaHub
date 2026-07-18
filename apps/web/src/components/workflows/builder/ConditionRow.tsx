import {
  Box,
  Autocomplete,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  Tooltip,
} from '@mui/material';
import { DeleteOutlined } from '@mui/icons-material';
import { ConditionValueEditor } from './ConditionValueEditor';
import type { ExploreItem } from '../../../services/media';
import type { Album } from '../../../types/media';
import type {
  WorkflowFieldDescriptor,
  WorkflowLeafCondition,
  WorkflowOperator,
} from '../../../types/workflows';

// Human-readable operator labels.
const OPERATOR_LABELS: Record<WorkflowOperator, string> = {
  contains: 'contains',
  starts_with: 'starts with',
  ends_with: 'ends with',
  equals: 'is',
  gt: 'greater than',
  lt: 'less than',
  gte: 'at least',
  between: 'is between',
  before: 'is before',
  after: 'is after',
  older_than_days: 'is older than (days)',
  within_last_days: 'is within last (days)',
  is: 'is',
  is_set: 'is set',
  has_any: 'has any of',
  has_all: 'has all of',
  has_none: 'has none of',
  has_person: 'includes',
  not_has_person: 'excludes',
  in_album: 'is in album',
  not_in_album: 'is not in album',
  near: 'is near',
};

// Field-picker option shape (carries its group for Autocomplete grouping).
interface FieldOption {
  key: string;
  label: string;
  group: string;
}

// Stable group ordering for the field picker.
const GROUP_ORDER = [
  'File',
  'Dates',
  'Location',
  'Tags',
  'People',
  'Media',
  'Organization',
  'Review',
];

interface ConditionRowProps {
  circleId: string;
  fields: WorkflowFieldDescriptor[];
  condition: WorkflowLeafCondition;
  onChange: (patch: Partial<WorkflowLeafCondition>) => void;
  onRemove: () => void;
  tags: ExploreItem[];
  albums: Album[];
}

// ---------------------------------------------------------------------------
// ConditionRow — one leaf condition: grouped field Select, an operator Select
// filtered to that field, and a per-type value editor.
// ---------------------------------------------------------------------------

export function ConditionRow({
  circleId,
  fields,
  condition,
  onChange,
  onRemove,
  tags,
  albums,
}: ConditionRowProps) {
  const options: FieldOption[] = [...fields]
    .map((f) => ({ key: f.key, label: f.label, group: f.group }))
    .sort((a, b) => {
      const ga = GROUP_ORDER.indexOf(a.group);
      const gb = GROUP_ORDER.indexOf(b.group);
      if (ga !== gb) return ga - gb;
      return a.label.localeCompare(b.label);
    });

  const field = fields.find((f) => f.key === condition.field);
  const selectedOption = options.find((o) => o.key === condition.field) ?? null;
  const op = condition.op as WorkflowOperator;

  const handleFieldChange = (next: FieldOption | null) => {
    if (!next) {
      onChange({ field: '', op: '', value: undefined });
      return;
    }
    const nextField = fields.find((f) => f.key === next.key);
    // Default to the field's first operator; reset the value.
    onChange({
      field: next.key,
      op: nextField?.operators[0] ?? '',
      value: undefined,
    });
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 1.5,
        alignItems: 'flex-start',
        p: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
      }}
    >
      <Autocomplete<FieldOption>
        options={options}
        groupBy={(o) => o.group}
        value={selectedOption}
        onChange={(_, v) => handleFieldChange(v)}
        getOptionLabel={(o) => o.label}
        isOptionEqualToValue={(a, b) => a.key === b.key}
        size="small"
        sx={{ minWidth: 220 }}
        renderInput={(params) => <TextField {...params} label="Field" />}
      />

      <FormControl size="small" sx={{ minWidth: 170 }} disabled={!field}>
        <InputLabel>Condition</InputLabel>
        <Select
          label="Condition"
          value={field ? op : ''}
          onChange={(e) =>
            onChange({ op: e.target.value as WorkflowOperator, value: undefined })
          }
        >
          {(field?.operators ?? []).map((o) => (
            <MenuItem key={o} value={o}>
              {OPERATOR_LABELS[o] ?? o}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {field && op && (
        <Box sx={{ display: 'flex', flex: 1, minWidth: 200 }}>
          <ConditionValueEditor
            circleId={circleId}
            field={field}
            op={op}
            value={condition.value}
            onChange={(value) => onChange({ value })}
            tags={tags}
            albums={albums}
          />
        </Box>
      )}

      <Tooltip title="Remove condition">
        <IconButton size="small" onClick={onRemove} aria-label="Remove condition">
          <DeleteOutlined fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
