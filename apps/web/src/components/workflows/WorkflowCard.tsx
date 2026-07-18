import { useState, type MouseEvent } from 'react';
import {
  Card,
  CardContent,
  Box,
  Typography,
  Chip,
  Switch,
  FormControlLabel,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  MoreVert as MoreVertIcon,
  PlayArrow as PlayArrowIcon,
  ContentCopy as ContentCopyIcon,
  Delete as DeleteIcon,
  TouchApp as TouchAppIcon,
  AutoAwesome as AutoAwesomeIcon,
  Schedule as ScheduleIcon,
} from '@mui/icons-material';
import type { Workflow } from '../../types/workflows';
import {
  triggerLabel,
  cronToText,
  formatRelativeTime,
  runStatusColor,
  runStatusLabel,
} from '../../utils/workflowFormat';

interface WorkflowCardProps {
  workflow: Workflow;
  /** collaborator+ AND media:write */
  canManage: boolean;
  onToggleEnabled: (workflow: Workflow, enabled: boolean) => void;
  onOpen: (workflow: Workflow) => void;
  onRunNow: (workflow: Workflow) => void;
  onDuplicate: (workflow: Workflow) => void;
  onDelete: (workflow: Workflow) => void;
}

function triggerIcon(trigger: Workflow['trigger']) {
  switch (trigger) {
    case 'manual':
      return <TouchAppIcon fontSize="small" />;
    case 'on_media_enriched':
      return <AutoAwesomeIcon fontSize="small" />;
    case 'scheduled':
      return <ScheduleIcon fontSize="small" />;
    default:
      return undefined;
  }
}

export function WorkflowCard({
  workflow,
  canManage,
  onToggleEnabled,
  onOpen,
  onRunNow,
  onDuplicate,
  onDelete,
}: WorkflowCardProps) {
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(menuAnchor);

  const openMenu = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setMenuAnchor(e.currentTarget);
  };
  const closeMenu = () => setMenuAnchor(null);

  const handleMenuAction = (action: (w: Workflow) => void) => {
    closeMenu();
    action(workflow);
  };

  const scheduleLabel =
    workflow.trigger === 'scheduled'
      ? `${triggerLabel(workflow.trigger)} · ${cronToText(workflow.cronExpression)}`
      : triggerLabel(workflow.trigger);

  const lastRun = workflow.lastRun;

  return (
    <Card
      variant="outlined"
      sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <CardContent sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {/* Header: clickable name + kebab */}
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Typography
            variant="subtitle1"
            noWrap
            title={workflow.name}
            onClick={() => onOpen(workflow)}
            sx={{
              fontWeight: 600,
              flexGrow: 1,
              cursor: 'pointer',
              '&:hover': { textDecoration: 'underline' },
            }}
          >
            {workflow.name}
          </Typography>
          {canManage && (
            <IconButton
              size="small"
              onClick={openMenu}
              aria-label="Workflow actions"
              sx={{ mt: -0.5, mr: -0.5 }}
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
          )}
          <Menu anchorEl={menuAnchor} open={menuOpen} onClose={closeMenu}>
            <MenuItem onClick={() => handleMenuAction(onRunNow)}>
              <ListItemIcon>
                <PlayArrowIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Run now</ListItemText>
            </MenuItem>
            <MenuItem onClick={() => handleMenuAction(onDuplicate)}>
              <ListItemIcon>
                <ContentCopyIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Duplicate</ListItemText>
            </MenuItem>
            <MenuItem onClick={() => handleMenuAction(onDelete)}>
              <ListItemIcon>
                <DeleteIcon fontSize="small" color="error" />
              </ListItemIcon>
              <ListItemText sx={{ color: 'error.main' }}>Delete</ListItemText>
            </MenuItem>
          </Menu>
        </Box>

        {/* Description (2-line clamp) or muted placeholder */}
        {workflow.description ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {workflow.description}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.disabled" sx={{ fontStyle: 'italic' }}>
            No description
          </Typography>
        )}

        {/* Chips: subject + trigger */}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          <Chip size="small" label="Media Items" />
          <Chip
            size="small"
            variant="outlined"
            icon={triggerIcon(workflow.trigger)}
            label={scheduleLabel}
          />
        </Box>

        {/* Next run (scheduled only) */}
        {workflow.trigger === 'scheduled' && workflow.nextRunAt && (
          <Typography variant="caption" color="text.secondary">
            Next run: {formatRelativeTime(workflow.nextRunAt)}
          </Typography>
        )}

        {/* Last-run chip / never-run caption */}
        <Box sx={{ mt: 'auto', pt: 1 }}>
          {lastRun ? (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5 }}>
              <Chip
                size="small"
                color={runStatusColor(lastRun.status)}
                label={`${runStatusLabel(lastRun.status)} · ${formatRelativeTime(
                  lastRun.finishedAt ?? lastRun.createdAt,
                )}`}
              />
              <Typography variant="caption" color="text.secondary">
                ✓{lastRun.succeededCount} ✗{lastRun.failedCount}
              </Typography>
            </Box>
          ) : (
            <Typography variant="caption" color="text.disabled">
              Never run
            </Typography>
          )}
        </Box>

        {/* Enabled switch (kept out of any card-wide action area) */}
        <Box onClick={(e) => e.stopPropagation()}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={workflow.enabled}
                disabled={!canManage}
                onChange={(e) => onToggleEnabled(workflow, e.target.checked)}
              />
            }
            label={
              <Typography variant="body2" color="text.secondary">
                {workflow.enabled ? 'Enabled' : 'Disabled'}
              </Typography>
            }
          />
        </Box>
      </CardContent>
    </Card>
  );
}
