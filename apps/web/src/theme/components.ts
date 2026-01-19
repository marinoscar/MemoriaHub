import type { Components, Theme } from '@mui/material';

/**
 * MUI component overrides
 */
export const getComponentOverrides = (mode: 'dark' | 'light'): Components<Theme> => ({
  MuiCssBaseline: {
    styleOverrides: {
      body: {
        scrollbarColor: mode === 'dark' ? '#6b6b6b #2b2b2b' : '#c1c1c1 #f1f1f1',
        '&::-webkit-scrollbar, & *::-webkit-scrollbar': {
          width: 8,
          height: 8,
        },
        '&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb': {
          borderRadius: 8,
          backgroundColor: mode === 'dark' ? '#6b6b6b' : '#c1c1c1',
        },
        '&::-webkit-scrollbar-thumb:hover, & *::-webkit-scrollbar-thumb:hover': {
          backgroundColor: mode === 'dark' ? '#959595' : '#a8a8a8',
        },
        '&::-webkit-scrollbar-track, & *::-webkit-scrollbar-track': {
          backgroundColor: mode === 'dark' ? '#2b2b2b' : '#f1f1f1',
        },
      },
    },
  },
  MuiButton: {
    styleOverrides: {
      root: {
        textTransform: 'none',
        borderRadius: 8,
      },
    },
    defaultProps: {
      disableElevation: true,
    },
  },
  MuiPaper: {
    styleOverrides: {
      root: {
        borderRadius: 12,
      },
    },
  },
  MuiCard: {
    styleOverrides: {
      root: {
        borderRadius: 12,
      },
    },
  },
  MuiDialog: {
    styleOverrides: {
      paper: {
        borderRadius: 16,
      },
    },
  },
  MuiDrawer: {
    styleOverrides: {
      paper: {
        borderRadius: 0,
      },
    },
  },
  MuiAppBar: {
    styleOverrides: {
      root: {
        borderRadius: 0,
      },
    },
    defaultProps: {
      elevation: 0,
    },
  },
  MuiTextField: {
    defaultProps: {
      variant: 'outlined',
      size: 'small',
    },
  },
  MuiListItemButton: {
    styleOverrides: {
      root: {
        borderRadius: 8,
        marginLeft: 8,
        marginRight: 8,
        '&.Mui-selected': {
          backgroundColor: mode === 'dark' ? 'rgba(144, 202, 249, 0.16)' : 'rgba(25, 118, 210, 0.08)',
        },
      },
    },
  },
  MuiAvatar: {
    styleOverrides: {
      root: {
        cursor: 'pointer',
      },
    },
  },
});
