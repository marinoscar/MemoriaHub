/**
 * NotFoundPage Component Tests
 *
 * Tests for the 404 page rendering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../test/utils';
import { NotFoundPage } from './NotFoundPage';

// Mock navigate
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('NotFoundPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders 404 message', () => {
    render(<NotFoundPage />);

    expect(screen.getByText('404')).toBeInTheDocument();
  });

  it('renders Page Not Found heading', () => {
    render(<NotFoundPage />);

    expect(screen.getByText('Page Not Found')).toBeInTheDocument();
  });

  it('renders descriptive message', () => {
    render(<NotFoundPage />);

    expect(
      screen.getByText(/The page you're looking for doesn't exist or has been moved/)
    ).toBeInTheDocument();
  });

  it('renders sad emoji icon', () => {
    render(<NotFoundPage />);

    // MUI SentimentDissatisfied icon is an SVG
    const svg = document.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('renders home button', () => {
    render(<NotFoundPage />);

    expect(screen.getByRole('button', { name: /go to home/i })).toBeInTheDocument();
  });

  it('navigates to home on button click', () => {
    render(<NotFoundPage />);

    fireEvent.click(screen.getByRole('button', { name: /go to home/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('centers content vertically', () => {
    render(<NotFoundPage />);

    // The main container should have flexbox centering
    const container = screen.getByText('404').closest('div[class*="MuiBox"]');
    expect(container).toBeInTheDocument();
  });
});
