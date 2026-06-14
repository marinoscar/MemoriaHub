import { useState } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  Divider,
  Typography,
  CircularProgress,
} from '@mui/material';
import {
  GroupWork as CircleIcon,
  KeyboardArrowDown as ArrowDownIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';

export function CircleSwitcher() {
  const { circles, activeCircle, setActiveCircle, loading } = useCircle();
  const navigate = useNavigate();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  if (loading && circles.length === 0) {
    return <CircularProgress size={20} sx={{ mr: 1 }} />;
  }

  const handleOpen = (e: React.MouseEvent<HTMLButtonElement>) =>
    setAnchorEl(e.currentTarget);
  const handleClose = () => setAnchorEl(null);

  const handleSelect = async (id: string) => {
    handleClose();
    await setActiveCircle(id);
  };

  return (
    <>
      <Button
        color="inherit"
        startIcon={<CircleIcon />}
        endIcon={<ArrowDownIcon />}
        onClick={handleOpen}
        aria-label="Switch circle"
        aria-haspopup="true"
        aria-expanded={Boolean(anchorEl) ? 'true' : undefined}
        sx={{ mr: 1, textTransform: 'none', maxWidth: 180 }}
      >
        <Typography noWrap variant="body2" sx={{ maxWidth: 120 }}>
          {activeCircle?.name ?? 'No circle'}
        </Typography>
      </Button>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleClose}>
        {circles.map((c) => (
          <MenuItem
            key={c.id}
            onClick={() => void handleSelect(c.id)}
            selected={c.id === activeCircle?.id}
          >
            {c.name}
          </MenuItem>
        ))}
        {circles.length === 0 && <MenuItem disabled>No circles yet</MenuItem>}
        <Divider />
        <MenuItem
          onClick={() => {
            handleClose();
            navigate('/circles');
          }}
        >
          Manage Circles
        </MenuItem>
      </Menu>
    </>
  );
}
