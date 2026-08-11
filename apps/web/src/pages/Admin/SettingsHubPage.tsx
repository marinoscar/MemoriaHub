import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Grid,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Search as SearchIcon,
  Clear as ClearIcon,
  ChevronRight as ChevronRightIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { visibleAdminSections } from '../../config/adminSections';

export default function SettingsHubPage() {
  const navigate = useNavigate();
  const theme = useTheme();
  const { isAdmin, hasPermission } = usePermissions();
  // Phone treatment is a drill-down list rather than a card grid (spec §4.4):
  // there is no rail to swap into Console mode at this size, so the hub IS the
  // navigation and iOS Settings is the model every phone user already holds.
  const isPhone = useMediaQuery(theme.breakpoints.down('md'));
  const [query, setQuery] = useState('');

  // The make-or-break detail of the drill-down (spec §4.4 requirement 1):
  // returning from a page near the bottom of a 20-card list must land where the
  // user left it, not at the top.
  useScrollRestoration('admin-settings-hub');

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  // ONE declaration, three consumers — see `config/adminSections.tsx`. The
  // permission gate and the "Search settings" title match both live in the
  // shared helper, so the hub, the Console rail, and the AppBar title resolver
  // can never disagree about what an admin may see.
  const sections = visibleAdminSections(hasPermission, query);
  const trimmedQuery = query.trim();

  const searchField = (
    <TextField
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      size="small"
      placeholder="Search settings"
      // Client-side only over an in-memory array, so no debounce is warranted.
      // 23 items across five groups is past the point where scanning beats
      // typing, and unlike a rail or a tab strip it stays constant-effort for
      // the user as the admin surface grows (spec §4.4 requirement 4).
      sx={{ mb: 3, width: '100%', maxWidth: { xs: '100%', sm: 420 } }}
      slotProps={{
        htmlInput: { 'aria-label': 'Search settings' },
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" color="disabled" />
            </InputAdornment>
          ),
          endAdornment: query ? (
            <InputAdornment position="end">
              <IconButton
                size="small"
                aria-label="Clear settings search"
                onClick={() => setQuery('')}
              >
                <ClearIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ) : null,
        },
      }}
    />
  );

  return (
    <Box sx={{ p: { xs: 2, md: 4 } }}>
      <Typography variant="h4" gutterBottom sx={{ fontWeight: 700 }}>
        Settings
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Manage system configuration, providers, and operational settings.
      </Typography>

      {searchField}

      {/* Only ever an empty SEARCH result — an admin with no visible sections
          at all is a permission problem, not something to phrase as a miss. */}
      {sections.length === 0 && trimmedQuery !== '' && (
        <Typography variant="body2" color="text.secondary">
          No settings match “{trimmedQuery}”.
        </Typography>
      )}

      {sections.map((section) => (
        <Box key={section.label} sx={{ mb: 4 }}>
          <Typography
            variant="overline"
            sx={{
              display: 'block',
              mb: isPhone ? 0.5 : 1.5,
              color: 'text.secondary',
              fontWeight: 600,
              letterSpacing: '0.1em',
            }}
          >
            {section.label}
          </Typography>

          {isPhone ? (
            // Title + chevron is the WHOLE row. Descriptions are deliberately
            // dropped here: at this width they would triple the list's height
            // and defeat the point of a scannable hierarchy — they stay on the
            // tablet/desktop card grid below.
            <List disablePadding>
              {section.cards.map((card) => (
                <ListItemButton
                  key={card.title}
                  disabled={card.disabled || !card.path}
                  onClick={() => card.path && navigate(card.path)}
                  sx={{
                    borderRadius: 1,
                    borderBottom: `1px solid ${theme.palette.divider}`,
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 40, color: 'primary.main' }}>
                    <card.Icon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText primary={card.title} />
                  {card.disabled ? (
                    <Chip label="Coming soon" size="small" />
                  ) : (
                    <ChevronRightIcon fontSize="small" color="disabled" />
                  )}
                </ListItemButton>
              ))}
            </List>
          ) : (
            <Grid container spacing={2}>
              {section.cards.map((card) => (
                <Grid key={card.title} size={{ xs: 12, sm: 6, md: 4 }}>
                  {card.disabled ? (
                    <Card
                      sx={{
                        height: '100%',
                        opacity: 0.6,
                        cursor: 'default',
                      }}
                      variant="outlined"
                    >
                      <CardContent>
                        <card.Icon sx={{ fontSize: 40 }} color="primary" />
                        <Typography
                          variant="subtitle1"
                          sx={{ fontWeight: 600, mt: 1 }}
                        >
                          {card.title}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                          {card.description}
                        </Typography>
                        <Chip label="Coming soon" size="small" sx={{ mt: 1 }} />
                      </CardContent>
                    </Card>
                  ) : (
                    <Card sx={{ height: '100%' }} variant="outlined">
                      <CardActionArea
                        onClick={() => card.path && navigate(card.path)}
                        sx={{ height: '100%', alignItems: 'flex-start' }}
                      >
                        <CardContent>
                          <card.Icon sx={{ fontSize: 40 }} color="primary" />
                          <Typography
                            variant="subtitle1"
                            sx={{ fontWeight: 600, mt: 1 }}
                          >
                            {card.title}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {card.description}
                          </Typography>
                        </CardContent>
                      </CardActionArea>
                    </Card>
                  )}
                </Grid>
              ))}
            </Grid>
          )}
        </Box>
      ))}
    </Box>
  );
}
