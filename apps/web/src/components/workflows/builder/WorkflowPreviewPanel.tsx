import { useEffect, useMemo, useRef } from 'react';
import {
  Paper,
  Box,
  Typography,
  CircularProgress,
  Alert,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { ExpandMore, AutoAwesome } from '@mui/icons-material';
import { useWorkflowPreview } from '../../../hooks/useWorkflowPreview';
import { definitionToSentence } from '../../../utils/workflowSentence';
import { sanitizeDefinitionForPreview } from '../../../pages/Workflows/builderState';
import type {
  WorkflowDefinition,
  WorkflowTriggerType,
  SubjectRegistryEntry,
} from '../../../types/workflows';

interface WorkflowPreviewPanelProps {
  circleId: string;
  definition: WorkflowDefinition;
  subjectEntry: SubjectRegistryEntry | undefined;
  trigger: WorkflowTriggerType;
  cronExpression: string;
}

const DEBOUNCE_MS = 600;

// ---------------------------------------------------------------------------
// WorkflowPreviewPanel — the plain-language summary plus a debounced live match
// preview ("N matching items" + a 12-thumbnail sample). Sticky on desktop,
// collapsible on mobile.
// ---------------------------------------------------------------------------

export function WorkflowPreviewPanel({
  circleId,
  definition,
  subjectEntry,
  trigger,
  cronExpression,
}: WorkflowPreviewPanelProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const { preview, data, isLoading, error } = useWorkflowPreview();

  const sentence = useMemo(
    () => definitionToSentence(definition, subjectEntry, trigger, cronExpression),
    [definition, subjectEntry, trigger, cronExpression],
  );

  // Debounced preview on any change to the (sanitized) definition.
  const sanitized = useMemo(
    () => sanitizeDefinitionForPreview(definition),
    [definition],
  );
  const key = useMemo(
    () => JSON.stringify({ circleId, conditions: sanitized.conditions, match: sanitized.match }),
    [circleId, sanitized],
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!circleId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void preview({ circleId, definition: sanitized });
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // `key` captures every relevant field of `sanitized`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, circleId, preview]);

  const countLabel =
    data == null
      ? null
      : data.capped
        ? `${data.matchedCount.toLocaleString()}+`
        : data.matchedCount.toLocaleString();

  const body = (
    <>
      {/* Plain-language summary */}
      <Box
        sx={{
          display: 'flex',
          gap: 1,
          alignItems: 'flex-start',
          p: 1.5,
          mb: 2,
          borderRadius: 1,
          bgcolor: 'action.hover',
        }}
      >
        <AutoAwesome fontSize="small" color="primary" sx={{ mt: 0.25 }} />
        <Box>
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ lineHeight: 1.2, display: 'block' }}
          >
            In plain language
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {sentence}
          </Typography>
        </Box>
      </Box>

      {/* Match count */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, minHeight: 40 }}>
        {isLoading ? (
          <>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              Counting matches…
            </Typography>
          </>
        ) : error ? (
          <Alert severity="error" sx={{ width: '100%' }}>
            {error}
          </Alert>
        ) : countLabel != null ? (
          <>
            <Chip label={countLabel} color="primary" />
            <Typography variant="body2" color="text.secondary">
              matching item{data && data.matchedCount === 1 && !data.capped ? '' : 's'}
            </Typography>
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Adjust conditions to preview matches.
          </Typography>
        )}
      </Box>

      {/* Sample grid */}
      {data && data.matchedCount === 0 && !isLoading && !error && (
        <Alert severity="info">No items match yet.</Alert>
      )}
      {data && data.sample.length > 0 && (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 0.75,
          }}
        >
          {data.sample.slice(0, 12).map((item) => (
            <Box
              key={item.id}
              sx={{
                position: 'relative',
                aspectRatio: '1 / 1',
                borderRadius: 1,
                overflow: 'hidden',
                bgcolor: 'action.selected',
              }}
            >
              {item.thumbnailUrl ? (
                <Box
                  component="img"
                  src={item.thumbnailUrl}
                  alt={item.filename ?? 'sample'}
                  loading="lazy"
                  sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              ) : null}
            </Box>
          ))}
        </Box>
      )}
    </>
  );

  if (isMobile) {
    return (
      <Accordion defaultExpanded variant="outlined" sx={{ borderRadius: 2, width: '100%' }}>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            Preview{countLabel != null ? ` · ${countLabel} items` : ''}
          </Typography>
        </AccordionSummary>
        <AccordionDetails>{body}</AccordionDetails>
      </Accordion>
    );
  }

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        borderRadius: 2,
        width: 340,
        flexShrink: 0,
        position: 'sticky',
        top: 16,
        alignSelf: 'flex-start',
      }}
    >
      <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
        Live preview
      </Typography>
      {body}
    </Paper>
  );
}
