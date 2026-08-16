import {
  Card,
  CardContent,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
  Box,
} from '@mui/material';
import LightIcon from '@mui/icons-material/LightMode';
import DarkIcon from '@mui/icons-material/DarkMode';
import SystemIcon from '@mui/icons-material/SettingsBrightness';

interface ThemeSettingsProps {
  currentTheme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  disabled?: boolean;
}

export function ThemeSettings({
  currentTheme,
  onThemeChange,
  disabled = false,
}: ThemeSettingsProps) {
  const handleChange = (
    _event: React.MouseEvent<HTMLElement>,
    newTheme: 'light' | 'dark' | 'system' | null,
  ) => {
    if (newTheme !== null) {
      onThemeChange(newTheme);
    }
  };

  return (
    <Card id="theme">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Appearance
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Choose how the application looks to you
        </Typography>

        {/*
          size="small" + flexWrap are load-bearing: MUI's group root is
          inline-flex/nowrap and CardContent sets no overflow, so at a narrow
          viewport the third ("System") option was clipped off the card's
          right edge and unreachable. The inner Box also carried its own px:1
          on top of MUI's button padding — dropped, since that extra ~16px per
          button is what pushed the group past the card in the first place.
        */}
        <ToggleButtonGroup
          value={currentTheme}
          exclusive
          onChange={handleChange}
          aria-label="theme selection"
          disabled={disabled}
          size="small"
          sx={{ mt: 1, flexWrap: 'wrap' }}
        >
          <ToggleButton value="light" aria-label="light mode">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <LightIcon fontSize="small" />
              <span>Light</span>
            </Box>
          </ToggleButton>
          <ToggleButton value="dark" aria-label="dark mode">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <DarkIcon fontSize="small" />
              <span>Dark</span>
            </Box>
          </ToggleButton>
          <ToggleButton value="system" aria-label="system preference">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <SystemIcon fontSize="small" />
              <span>System</span>
            </Box>
          </ToggleButton>
        </ToggleButtonGroup>
      </CardContent>
    </Card>
  );
}
