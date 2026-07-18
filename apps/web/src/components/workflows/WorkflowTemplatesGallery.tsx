import { Box, Typography, Grid, Card, CardActionArea, CardContent } from '@mui/material';
import { AddCircleOutline as AddCircleOutlineIcon } from '@mui/icons-material';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../../constants/workflowTemplates';

interface WorkflowTemplatesGalleryProps {
  onSelect: (template: WorkflowTemplate) => void;
  /**
   * When provided, prepends a "Start from scratch" card that invokes this
   * callback (the parent navigates to a blank builder). Omitted → no card.
   */
  onStartFromScratch?: () => void;
  heading?: string;
}

/**
 * Props-driven gallery of ready-made workflow templates. Renders a responsive
 * card grid; clicking a template card calls `onSelect(template)` and the
 * optional "Start from scratch" card calls `onStartFromScratch()`. Navigation
 * is the parent's responsibility — this component performs none, so it stays
 * trivially testable.
 */
export function WorkflowTemplatesGallery({
  onSelect,
  onStartFromScratch,
  heading = 'Start from a template',
}: WorkflowTemplatesGalleryProps) {
  return (
    <Box>
      {heading && (
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
          {heading}
        </Typography>
      )}
      <Grid container spacing={2}>
        {WORKFLOW_TEMPLATES.map((template) => {
          const Icon = template.icon;
          return (
            <Grid key={template.id} size={{ xs: 12, sm: 6, md: 4 }}>
              <Card
                variant="outlined"
                sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
              >
                <CardActionArea
                  onClick={() => onSelect(template)}
                  sx={{
                    flexGrow: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                  }}
                >
                  <CardContent sx={{ flexGrow: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                      <Icon color="primary" />
                      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                        {template.title}
                      </Typography>
                    </Box>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      {template.description}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', fontStyle: 'italic' }}
                    >
                      {template.plainLanguage}
                    </Typography>
                  </CardContent>
                </CardActionArea>
              </Card>
            </Grid>
          );
        })}

        {onStartFromScratch && (
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <Card
              variant="outlined"
              sx={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                borderStyle: 'dashed',
              }}
            >
              <CardActionArea
                onClick={onStartFromScratch}
                sx={{
                  flexGrow: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: 140,
                  textAlign: 'center',
                  p: 2,
                }}
              >
                <AddCircleOutlineIcon sx={{ fontSize: 40, color: 'text.secondary', mb: 1 }} />
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  Start from scratch
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Build a new workflow with a blank rule.
                </Typography>
              </CardActionArea>
            </Card>
          </Grid>
        )}
      </Grid>
    </Box>
  );
}

export default WorkflowTemplatesGallery;
