/**
 * Example component test
 *
 * This file demonstrates the testing patterns for React components.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '../../test/utils';
import { LoadingSpinner } from './LoadingSpinner';

describe('LoadingSpinner', () => {
  it('renders a loading spinner', () => {
    render(<LoadingSpinner />);

    // MUI CircularProgress has role="progressbar"
    const spinner = screen.getByRole('progressbar');
    expect(spinner).toBeInTheDocument();
  });

  it('is centered in the container', () => {
    const { container } = render(<LoadingSpinner />);

    // Check that the container has flex centering
    const box = container.firstChild as HTMLElement;
    expect(box).toHaveStyle({ display: 'flex' });
  });
});
