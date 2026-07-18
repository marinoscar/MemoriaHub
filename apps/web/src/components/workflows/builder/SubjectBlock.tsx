import {
  FormControl,
  Select,
  MenuItem,
  Box,
  Typography,
  Tooltip,
} from '@mui/material';
import { InfoOutlined } from '@mui/icons-material';
import { BuilderBlock } from './BuilderBlock';
import type { SubjectRegistryEntry, WorkflowSubjectType } from '../../../types/workflows';

interface SubjectBlockProps {
  subjects: SubjectRegistryEntry[];
  value: WorkflowSubjectType;
  onChange: (subject: WorkflowSubjectType) => void;
}

// ---------------------------------------------------------------------------
// SubjectBlock — "This workflow applies to: [Media Items ▾]". v1 exposes the
// single `media_item` Subject from the registry, with a subtle "more coming"
// affordance so the concept is visible even though it can't yet be changed.
// ---------------------------------------------------------------------------

export function SubjectBlock({ subjects, value, onChange }: SubjectBlockProps) {
  return (
    <BuilderBlock keyword="ON" title="Subject" color="primary">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="body1">This workflow applies to:</Typography>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <Select
            value={value}
            onChange={(e) => onChange(e.target.value as WorkflowSubjectType)}
            aria-label="Subject"
          >
            {subjects.map((s) => (
              <MenuItem key={s.subject} value={s.subject}>
                {s.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Tooltip title="More Subjects (duplicate groups, people, and more) are coming in a future release.">
          <Box
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.5,
              color: 'text.secondary',
            }}
          >
            <InfoOutlined fontSize="small" />
            <Typography variant="caption">More coming</Typography>
          </Box>
        </Tooltip>
      </Box>
    </BuilderBlock>
  );
}
