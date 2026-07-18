import {
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  Tooltip,
  Alert,
  Typography,
} from '@mui/material';
import {
  DeleteOutlined,
  ArrowUpward,
  ArrowDownward,
  WarningAmber,
} from '@mui/icons-material';
import { ActionParamEditor } from './ActionParamEditor';
import type { ExploreItem } from '../../../services/media';
import type { Album } from '../../../types/media';
import type {
  WorkflowActionInstance,
  WorkflowActionDescriptor,
} from '../../../types/workflows';
import {
  MANUAL_ONLY_ACTIONS,
  HIGH_IMPACT_ACTIONS,
  defaultActionInstance,
} from '../../../constants/workflowActionMeta';

interface ActionRowProps {
  circleId: string;
  index: number;
  total: number;
  action: WorkflowActionInstance;
  actionCatalog: WorkflowActionDescriptor[];
  onChange: (action: WorkflowActionInstance) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  tags: ExploreItem[];
  albums: Album[];
  /** null = unknown (non-admin). false = admin setting disables hard_delete. */
  hardDeleteAllowed: boolean | null;
}

// ---------------------------------------------------------------------------
// ActionRow — one action: reorder controls, a type Select from the registry
// action catalog, its parameter editor, and remove. hard_delete is
// error-colored with its manual-only / admin-gated / typed-confirmation
// constraints; move_to_circle carries a high-impact advisory.
// ---------------------------------------------------------------------------

export function ActionRow({
  circleId,
  index,
  total,
  action,
  actionCatalog,
  onChange,
  onRemove,
  onMove,
  tags,
  albums,
  hardDeleteAllowed,
}: ActionRowProps) {
  const descriptor = actionCatalog.find((a) => a.type === action.type);
  const isDestructive = Boolean(descriptor?.destructive);
  const isHighImpact = HIGH_IMPACT_ACTIONS.has(action.type);

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1,
        alignItems: 'flex-start',
        p: 1.5,
        border: 1,
        borderColor: isDestructive ? 'error.main' : 'divider',
        borderRadius: 1,
      }}
    >
      {/* Reorder */}
      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        <Tooltip title="Move up">
          <span>
            <IconButton
              size="small"
              disabled={index === 0}
              onClick={() => onMove(-1)}
              aria-label="Move action up"
            >
              <ArrowUpward fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Move down">
          <span>
            <IconButton
              size="small"
              disabled={index === total - 1}
              onClick={() => onMove(1)}
              aria-label="Move action down"
            >
              <ArrowDownward fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel>Action</InputLabel>
            <Select
              label="Action"
              value={action.type}
              onChange={(e) => onChange(defaultActionInstance(e.target.value))}
            >
              {actionCatalog.map((a) => (
                <MenuItem
                  key={a.type}
                  value={a.type}
                  sx={a.destructive ? { color: 'error.main' } : undefined}
                >
                  {a.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <ActionParamEditor
            circleId={circleId}
            action={action}
            onChange={onChange}
            tags={tags}
            albums={albums}
          />
        </Box>

        {MANUAL_ONLY_ACTIONS.has(action.type) && (
          <Alert
            severity="error"
            icon={<WarningAmber fontSize="small" />}
            sx={{ mt: 1.5 }}
          >
            <Typography variant="body2" component="div" sx={{ fontWeight: 600 }}>
              Permanent delete — use with care
            </Typography>
            Manual trigger only · requires admin to enable and the media:delete
            permission · a typed confirmation is required on the approval screen.
            The deletion is unrecoverable.
            {hardDeleteAllowed === false && (
              <Box sx={{ mt: 0.5, fontWeight: 600 }}>
                This action is currently disabled by the admin setting
                (workflows.allowHardDelete). Saving will be rejected.
              </Box>
            )}
          </Alert>
        )}

        {isHighImpact && !MANUAL_ONLY_ACTIONS.has(action.type) && (
          <Alert
            severity="warning"
            icon={<WarningAmber fontSize="small" />}
            sx={{ mt: 1.5 }}
          >
            High-impact action — moving items re-runs enrichment in the
            destination circle and requires media:write on both circles.
          </Alert>
        )}
      </Box>

      <Tooltip title="Remove action">
        <IconButton size="small" onClick={onRemove} aria-label="Remove action">
          <DeleteOutlined fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
