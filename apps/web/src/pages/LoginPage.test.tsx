/**
 * LoginPage Component Tests
 *
 * Tests for the login page rendering.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../test/utils';
import { LoginPage } from './LoginPage';

// Mock LoginButton
vi.mock('../components/auth', () => ({
  LoginButton: ({ provider }: { provider: string }) => (
    <button data-testid={`login-${provider}`}>Sign in with {provider}</button>
  ),
}));

describe('LoginPage', () => {
  it('renders logo', () => {
    render(<LoginPage />);

    // MUI PhotoLibrary icon is an SVG
    const svg = document.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('renders welcome title', () => {
    render(<LoginPage />);

    expect(screen.getByRole('heading', { name: 'MemoriaHub' })).toBeInTheDocument();
  });

  it('renders description text', () => {
    render(<LoginPage />);

    expect(screen.getByText('Privacy-first family photo platform')).toBeInTheDocument();
  });

  it('renders Google login button', () => {
    render(<LoginPage />);

    expect(screen.getByTestId('login-google')).toBeInTheDocument();
  });

  it('renders sign in text', () => {
    render(<LoginPage />);

    expect(screen.getByText('Sign in to continue')).toBeInTheDocument();
  });

  it('renders terms and privacy footer', () => {
    render(<LoginPage />);

    expect(
      screen.getByText(/By signing in, you agree to our Terms of Service and Privacy Policy/i)
    ).toBeInTheDocument();
  });

  it('centers content on page', () => {
    render(<LoginPage />);

    // The Paper container should be present
    const paper = document.querySelector('.MuiPaper-root');
    expect(paper).toBeInTheDocument();
  });
});
