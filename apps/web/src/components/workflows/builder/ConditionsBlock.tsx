import {
  Box,
  Button,
  Stack,
  ToggleButtonGroup,
  ToggleButton,
  Typography,
  IconButton,
  Tooltip,
  Paper,
} from '@mui/material';
import { Add, DeleteOutlined, AccountTree } from '@mui/icons-material';
import { ConditionRow } from './ConditionRow';
import { useConditionEditorData } from './ConditionValueEditor';
import { BuilderBlock } from './BuilderBlock';
import type { BuilderAction } from '../../../pages/Workflows/builderState';
import { isWorkflowGroupCondition } from '../../../types/workflows';
import type {
  WorkflowFieldDescriptor,
  WorkflowMatch,
  WorkflowTopCondition,
  WorkflowLeafCondition,
} from '../../../types/workflows';

interface ConditionsBlockProps {
  circleId: string;
  fields: WorkflowFieldDescriptor[];
  match: WorkflowMatch;
  conditions: WorkflowTopCondition[];
  dispatch: (action: BuilderAction) => void;
}

function MatchToggle({
  value,
  onChange,
  size = 'small',
}: {
  value: WorkflowMatch;
  onChange: (m: WorkflowMatch) => void;
  size?: 'small' | 'medium';
}) {
  return (
    <ToggleButtonGroup
      exclusive
      size={size}
      value={value}
      onChange={(_, v: WorkflowMatch | null) => {
        if (v !== null) onChange(v);
      }}
    >
      <ToggleButton value="all">Match ALL</ToggleButton>
      <ToggleButton value="any">Match ANY</ToggleButton>
    </ToggleButtonGroup>
  );
}

// ---------------------------------------------------------------------------
// ConditionsBlock — the "If" block: an all/any match toggle plus a list of
// leaf rows and (one level of) nested condition groups.
// ---------------------------------------------------------------------------

export function ConditionsBlock({
  circleId,
  fields,
  match,
  conditions,
  dispatch,
}: ConditionsBlockProps) {
  const { tags, albums } = useConditionEditorData(circleId);

  return (
    <BuilderBlock
      keyword="IF"
      title="Conditions"
      subtitle="Only items matching these conditions are acted on. Leave empty to match every item."
      color="info"
      action={<MatchToggle value={match} onChange={(m) => dispatch({ kind: 'setMatch', value: m })} />}
    >
      <Stack spacing={1.5}>
        {conditions.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No conditions yet — this workflow will match every item in the circle.
          </Typography>
        )}

        {conditions.map((c, index) => {
          if (isWorkflowGroupCondition(c)) {
            return (
              <Paper
                key={index}
                variant="outlined"
                sx={{ p: 1.5, borderRadius: 1, bgcolor: 'action.hover', ml: { sm: 2 } }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    mb: 1.5,
                    flexWrap: 'wrap',
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <AccountTree fontSize="small" color="action" />
                    <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                      Condition group
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <MatchToggle
                      value={c.match}
                      onChange={(m) =>
                        dispatch({ kind: 'setGroupMatch', groupIndex: index, value: m })
                      }
                    />
                    <Tooltip title="Remove group">
                      <IconButton
                        size="small"
                        onClick={() => dispatch({ kind: 'removeTop', index })}
                        aria-label="Remove group"
                      >
                        <DeleteOutlined fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>

                <Stack spacing={1.5}>
                  {c.conditions.map((leaf: WorkflowLeafCondition, childIndex) => (
                    <ConditionRow
                      key={childIndex}
                      circleId={circleId}
                      fields={fields}
                      condition={leaf}
                      tags={tags}
                      albums={albums}
                      onChange={(patch) =>
                        dispatch({
                          kind: 'updateGroupLeaf',
                          groupIndex: index,
                          childIndex,
                          patch,
                        })
                      }
                      onRemove={() =>
                        dispatch({ kind: 'removeGroupLeaf', groupIndex: index, childIndex })
                      }
                    />
                  ))}
                  <Box>
                    <Button
                      size="small"
                      startIcon={<Add />}
                      onClick={() => dispatch({ kind: 'addGroupLeaf', groupIndex: index })}
                    >
                      Add condition to group
                    </Button>
                  </Box>
                </Stack>
              </Paper>
            );
          }

          return (
            <ConditionRow
              key={index}
              circleId={circleId}
              fields={fields}
              condition={c}
              tags={tags}
              albums={albums}
              onChange={(patch) => dispatch({ kind: 'updateLeaf', index, patch })}
              onRemove={() => dispatch({ kind: 'removeTop', index })}
            />
          );
        })}

        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', pt: 0.5 }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<Add />}
            onClick={() => dispatch({ kind: 'addLeaf' })}
          >
            Add condition
          </Button>
          <Button
            variant="text"
            size="small"
            startIcon={<AccountTree />}
            onClick={() => dispatch({ kind: 'addGroup' })}
          >
            Add condition group
          </Button>
        </Box>
      </Stack>
    </BuilderBlock>
  );
}
