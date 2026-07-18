import { Box, Button, Stack, Typography, Alert } from '@mui/material';
import { Add } from '@mui/icons-material';
import { ActionRow } from './ActionRow';
import { useConditionEditorData } from './ConditionValueEditor';
import { BuilderBlock } from './BuilderBlock';
import { defaultActionInstance } from '../../../constants/workflowActionMeta';
import type { BuilderAction } from '../../../pages/Workflows/builderState';
import type {
  WorkflowActionInstance,
  WorkflowActionDescriptor,
} from '../../../types/workflows';

interface ActionsBlockProps {
  circleId: string;
  actionCatalog: WorkflowActionDescriptor[];
  actions: WorkflowActionInstance[];
  dispatch: (action: BuilderAction) => void;
  hardDeleteAllowed: boolean | null;
}

// ---------------------------------------------------------------------------
// ActionsBlock — the "Then" block: an ordered, reorderable list of actions,
// each with a type Select and a per-action parameter editor.
// ---------------------------------------------------------------------------

export function ActionsBlock({
  circleId,
  actionCatalog,
  actions,
  dispatch,
  hardDeleteAllowed,
}: ActionsBlockProps) {
  const { tags, albums } = useConditionEditorData(circleId);

  // First non-destructive action makes a sensible default for a new row.
  const firstType =
    actionCatalog.find((a) => !a.destructive)?.type ?? actionCatalog[0]?.type ?? 'move_to_trash';

  return (
    <BuilderBlock
      keyword="THEN"
      title="Actions"
      subtitle="These actions run in order on every matching item."
      color="success"
    >
      <Stack spacing={1.5}>
        {actions.length === 0 && (
          <Alert severity="info">
            Add at least one action for this workflow to do anything.
          </Alert>
        )}

        {actions.map((action, index) => (
          <ActionRow
            key={index}
            circleId={circleId}
            index={index}
            total={actions.length}
            action={action}
            actionCatalog={actionCatalog}
            tags={tags}
            albums={albums}
            hardDeleteAllowed={hardDeleteAllowed}
            onChange={(next) => dispatch({ kind: 'setAction', index, action: next })}
            onRemove={() => dispatch({ kind: 'removeAction', index })}
            onMove={(direction) => dispatch({ kind: 'moveAction', index, direction })}
          />
        ))}

        <Box sx={{ pt: 0.5 }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<Add />}
            onClick={() =>
              dispatch({ kind: 'addAction', action: defaultActionInstance(firstType) })
            }
          >
            Add action
          </Button>
        </Box>

        <Typography variant="caption" color="text.secondary">
          Actions apply to every matching item in run order.
        </Typography>
      </Stack>
    </BuilderBlock>
  );
}
