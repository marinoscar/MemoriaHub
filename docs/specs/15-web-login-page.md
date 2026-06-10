# Spec 15: Web Login Page

**Domain:** Frontend
**Agent:** `frontend-dev`
**Depends On:** 14-web-auth-context
**Estimated Complexity:** Low

---

## Objective

Create a login page that displays available OAuth providers and allows users to initiate authentication.

---

## Deliverables

### 1. File Structure

```
apps/web/src/
├── pages/
│   └── LoginPage.tsx
├── components/
│   └── auth/
│       └── OAuthButton.tsx
```

### 2. Login Page

Create `apps/web/src/pages/LoginPage.tsx`:

```tsx
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Stack,
  Divider,
  useTheme,
} from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import { OAuthButton } from '../components/auth/OAuthButton';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

export default function LoginPage() {
  const { isAuthenticated, isLoading, providers, login } = useAuth();
  const navigate = useNavigate();
  const theme = useTheme();

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      navigate('/', { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  if (isLoading) {
    return <LoadingSpinner fullScreen />;
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: theme.palette.mode === 'dark'
          ? 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)'
          : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        p: 2,
      }}
    >
      <Card
        sx={{
          maxWidth: 400,
          width: '100%',
          boxShadow: theme.shadows[10],
        }}
      >
        <CardContent sx={{ p: 4 }}>
          {/* Logo/Header */}
          <Box sx={{ textAlign: 'center', mb: 4 }}>
            <Typography variant="h4" component="h1" fontWeight="bold">
              Welcome
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              Sign in to continue
            </Typography>
          </Box>

          <Divider sx={{ mb: 3 }}>
            <Typography variant="body2" color="text.secondary">
              Sign in with
            </Typography>
          </Divider>

          {/* OAuth Providers */}
          <Stack spacing={2}>
            {providers.length > 0 ? (
              providers.map((provider) => (
                <OAuthButton
                  key={provider.name}
                  provider={provider.name}
                  onClick={() => login(provider.name)}
                />
              ))
            ) : (
              <Typography color="text.secondary" textAlign="center">
                No authentication providers configured
              </Typography>
            )}
          </Stack>

          {/* Footer */}
          <Box sx={{ mt: 4, textAlign: 'center' }}>
            <Typography variant="caption" color="text.secondary">
              By signing in, you agree to our Terms of Service and Privacy Policy
            </Typography>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
```

### 3. OAuth Button Component

Create `apps/web/src/components/auth/OAuthButton.tsx`:

```tsx
import { Button, SvgIcon } from '@mui/material';

interface OAuthButtonProps {
  provider: string;
  onClick: () => void;
}

// Provider configurations
const providerConfig: Record<string, {
  label: string;
  icon: React.ReactNode;
  color: string;
  textColor: string;
}> = {
  google: {
    label: 'Continue with Google',
    icon: <GoogleIcon />,
    color: '#ffffff',
    textColor: '#757575',
  },
  microsoft: {
    label: 'Continue with Microsoft',
    icon: <MicrosoftIcon />,
    color: '#2f2f2f',
    textColor: '#ffffff',
  },
  github: {
    label: 'Continue with GitHub',
    icon: <GitHubIcon />,
    color: '#24292e',
    textColor: '#ffffff',
  },
};

export function OAuthButton({ provider, onClick }: OAuthButtonProps) {
  const config = providerConfig[provider.toLowerCase()] || {
    label: `Continue with ${provider}`,
    icon: null,
    color: '#1976d2',
    textColor: '#ffffff',
  };

  return (
    <Button
      fullWidth
      variant="contained"
      size="large"
      onClick={onClick}
      startIcon={config.icon}
      sx={{
        backgroundColor: config.color,
        color: config.textColor,
        textTransform: 'none',
        fontWeight: 500,
        py: 1.5,
        borderRadius: 2,
        border: provider === 'google' ? '1px solid #dadce0' : 'none',
        '&:hover': {
          backgroundColor: config.color,
          opacity: 0.9,
        },
      }}
    >
      {config.label}
    </Button>
  );
}

// SVG Icons
function GoogleIcon() {
  return (
    <SvgIcon viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </SvgIcon>
  );
}

function MicrosoftIcon() {
  return (
    <SvgIcon viewBox="0 0 24 24">
      <path fill="#f25022" d="M1 1h10v10H1z" />
      <path fill="#00a4ef" d="M1 13h10v10H1z" />
      <path fill="#7fba00" d="M13 1h10v10H13z" />
      <path fill="#ffb900" d="M13 13h10v10H13z" />
    </SvgIcon>
  );
}

function GitHubIcon() {
  return (
    <SvgIcon viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
      />
    </SvgIcon>
  );
}
```

---

## Responsive Design

The login page is fully responsive:

| Breakpoint | Behavior |
|------------|----------|
| Mobile (<600px) | Full width card with padding |
| Tablet (600-960px) | Card max-width 400px, centered |
| Desktop (>960px) | Same as tablet with gradient background |

---

## Dark Mode Support

The login page adapts to the current theme:

- **Light mode**: Purple gradient background
- **Dark mode**: Dark blue gradient background
- Card colors respect theme palette

---

## Provider Button Styles

Each OAuth provider has branded styling:

| Provider | Background | Text Color | Border |
|----------|------------|------------|--------|
| Google | White (#fff) | Gray (#757575) | Light gray border |
| Microsoft | Dark (#2f2f2f) | White | None |
| GitHub | Black (#24292e) | White | None |

---

## User Flow

1. User visits `/login`
2. If already authenticated, redirect to home
3. Display available OAuth providers from API
4. User clicks provider button
5. Store current location for return after auth
6. Redirect to `/api/auth/{provider}`
7. After OAuth, callback redirects to `/auth/callback`
8. AuthCallbackPage completes flow and redirects

---

## Acceptance Criteria

- [ ] Login page renders at `/login`
- [ ] Authenticated users redirected to home
- [ ] Available providers fetched from API
- [ ] Provider buttons display with correct branding
- [ ] Click triggers OAuth flow
- [ ] Loading state shows during auth check
- [ ] Responsive on mobile, tablet, and desktop
- [ ] Dark mode supported
- [ ] Error state if no providers configured

---

## Notes

- Provider list is dynamic from API, not hardcoded
- OAuth icons are inline SVGs for reliability
- Google requires specific styling per their guidelines
- Login page doesn't need auth guard (public route)
