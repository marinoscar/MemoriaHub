import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { CircleSwitcher } from '../../../components/circles/CircleSwitcher';

// ------------------------------------------------------------------
// Mock useCircle hook
// ------------------------------------------------------------------

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

import { useCircle } from '../../../hooks/useCircle';
const mockUseCircle = vi.mocked(useCircle);

const mockCircle1 = {
  id: 'circle-1',
  name: "Personal Library",
  description: null,
  ownerId: 'test-user-id',
  isPersonal: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockCircle2 = {
  id: 'circle-2',
  name: 'Family Circle',
  description: 'Our family',
  ownerId: 'test-user-id',
  isPersonal: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeCircleDefaults(overrides: Record<string, unknown> = {}) {
  return {
    circles: [mockCircle1, mockCircle2],
    activeCircle: mockCircle1,
    activeCircleId: 'circle-1',
    activeCircleRole: 'circle_admin' as const,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('CircleSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCircle.mockReturnValue(makeCircleDefaults());
  });

  it('renders active circle name', () => {
    render(<CircleSwitcher />);
    expect(screen.getByText('Personal Library')).toBeInTheDocument();
  });

  it('shows "No circle" when no active circle', () => {
    mockUseCircle.mockReturnValue(makeCircleDefaults({ activeCircle: null }));
    render(<CircleSwitcher />);
    expect(screen.getByText('No circle')).toBeInTheDocument();
  });

  it('shows loading spinner when loading and no circles', () => {
    mockUseCircle.mockReturnValue(makeCircleDefaults({ loading: true, circles: [] }));
    render(<CircleSwitcher />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('opens dropdown and shows all circles on button click', async () => {
    const user = userEvent.setup();
    render(<CircleSwitcher />);

    const switchBtn = screen.getByRole('button', { name: /switch circle/i });
    await user.click(switchBtn);

    // After opening, both the button text AND the dropdown item show "Personal Library"
    expect(screen.getAllByText('Personal Library').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Family Circle')).toBeInTheDocument();
    expect(screen.getByText('Manage Circles')).toBeInTheDocument();
  });

  it('calls setActiveCircle when a circle is selected', async () => {
    const setActiveCircle = vi.fn().mockResolvedValue(undefined);
    mockUseCircle.mockReturnValue(makeCircleDefaults({ setActiveCircle }));

    const user = userEvent.setup();
    render(<CircleSwitcher />);

    const switchBtn = screen.getByRole('button', { name: /switch circle/i });
    await user.click(switchBtn);

    const familyOption = screen.getByText('Family Circle');
    await user.click(familyOption);

    await waitFor(() => {
      expect(setActiveCircle).toHaveBeenCalledWith('circle-2');
    });
  });

  it('shows "No circles yet" when circles list is empty', async () => {
    mockUseCircle.mockReturnValue(makeCircleDefaults({ circles: [], activeCircle: null }));
    const user = userEvent.setup();
    render(<CircleSwitcher />);

    const switchBtn = screen.getByRole('button', { name: /switch circle/i });
    await user.click(switchBtn);

    expect(screen.getByText('No circles yet')).toBeInTheDocument();
  });
});
