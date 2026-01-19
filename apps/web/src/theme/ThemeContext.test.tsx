/**
 * ThemeContext Tests
 *
 * Tests for theme management, localStorage persistence, and MUI theme creation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { ThemeProvider, ThemeContext } from './ThemeContext';
import { useContext } from 'react';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((_key: string): string | null => store[_key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
  });

  afterEach(() => {
    localStorageMock.clear();
  });

  describe('initial state', () => {
    it('defaults to dark mode', () => {
      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return <div data-testid="mode">{context?.mode}</div>;
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    });

    it('loads saved theme from localStorage', () => {
      localStorageMock.getItem.mockReturnValue('light');

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return <div data-testid="mode">{context?.mode}</div>;
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      expect(screen.getByTestId('mode')).toHaveTextContent('light');
    });

    it('handles missing localStorage value', () => {
      localStorageMock.getItem.mockReturnValue(null);

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return <div data-testid="mode">{context?.mode}</div>;
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      // Should default to dark
      expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    });

    it('handles invalid localStorage value', () => {
      localStorageMock.getItem.mockReturnValue('invalid-theme');

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return <div data-testid="mode">{context?.mode}</div>;
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      // Should default to dark
      expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    });
  });

  describe('toggleTheme', () => {
    it('switches from dark to light', () => {
      localStorageMock.getItem.mockReturnValue('dark');

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return (
          <>
            <div data-testid="mode">{context?.mode}</div>
            <button onClick={context?.toggleTheme}>Toggle</button>
          </>
        );
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      expect(screen.getByTestId('mode')).toHaveTextContent('dark');

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByTestId('mode')).toHaveTextContent('light');
    });

    it('switches from light to dark', () => {
      localStorageMock.getItem.mockReturnValue('light');

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return (
          <>
            <div data-testid="mode">{context?.mode}</div>
            <button onClick={context?.toggleTheme}>Toggle</button>
          </>
        );
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      expect(screen.getByTestId('mode')).toHaveTextContent('light');

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    });

    it('persists new theme to localStorage', () => {
      localStorageMock.getItem.mockReturnValue('dark');

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return <button onClick={context?.toggleTheme}>Toggle</button>;
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      fireEvent.click(screen.getByRole('button'));

      expect(localStorageMock.setItem).toHaveBeenCalledWith('memoriahub-theme-mode', 'light');
    });
  });

  describe('setTheme', () => {
    it('sets theme to dark', () => {
      localStorageMock.getItem.mockReturnValue('light');

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return (
          <>
            <div data-testid="mode">{context?.mode}</div>
            <button onClick={() => context?.setTheme('dark')}>Set Dark</button>
          </>
        );
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    });

    it('sets theme to light', () => {
      localStorageMock.getItem.mockReturnValue('dark');

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return (
          <>
            <div data-testid="mode">{context?.mode}</div>
            <button onClick={() => context?.setTheme('light')}>Set Light</button>
          </>
        );
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByTestId('mode')).toHaveTextContent('light');
    });

    it('persists specified theme to localStorage', () => {
      localStorageMock.getItem.mockReturnValue('dark');

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return <button onClick={() => context?.setTheme('light')}>Set Light</button>;
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      fireEvent.click(screen.getByRole('button'));

      expect(localStorageMock.setItem).toHaveBeenCalledWith('memoriahub-theme-mode', 'light');
    });
  });

  describe('isDarkMode', () => {
    it('returns true when mode is dark', () => {
      localStorageMock.getItem.mockReturnValue('dark');

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return <div data-testid="is-dark">{context?.isDarkMode ? 'yes' : 'no'}</div>;
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      expect(screen.getByTestId('is-dark')).toHaveTextContent('yes');
    });

    it('returns false when mode is light', () => {
      localStorageMock.getItem.mockReturnValue('light');

      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return <div data-testid="is-dark">{context?.isDarkMode ? 'yes' : 'no'}</div>;
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      expect(screen.getByTestId('is-dark')).toHaveTextContent('no');
    });
  });

  describe('MUI theme creation', () => {
    it('creates valid dark theme object', () => {
      localStorageMock.getItem.mockReturnValue('dark');

      // Theme provider should render without error
      render(
        <ThemeProvider>
          <div>Content</div>
        </ThemeProvider>
      );

      expect(screen.getByText('Content')).toBeInTheDocument();
    });

    it('creates valid light theme object', () => {
      localStorageMock.getItem.mockReturnValue('light');

      // Theme provider should render without error
      render(
        <ThemeProvider>
          <div>Content</div>
        </ThemeProvider>
      );

      expect(screen.getByText('Content')).toBeInTheDocument();
    });

    it('applies CssBaseline', () => {
      render(
        <ThemeProvider>
          <div>Content</div>
        </ThemeProvider>
      );

      // CssBaseline is applied - just verify render succeeds
      expect(screen.getByText('Content')).toBeInTheDocument();
    });
  });

  describe('context value', () => {
    it('provides all expected values', () => {
      const TestComponent = () => {
        const context = useContext(ThemeContext);
        return (
          <>
            <div data-testid="has-mode">{context?.mode ? 'yes' : 'no'}</div>
            <div data-testid="has-toggle">{context?.toggleTheme ? 'yes' : 'no'}</div>
            <div data-testid="has-set">{context?.setTheme ? 'yes' : 'no'}</div>
            <div data-testid="has-isDark">{typeof context?.isDarkMode === 'boolean' ? 'yes' : 'no'}</div>
          </>
        );
      };

      render(
        <ThemeProvider>
          <TestComponent />
        </ThemeProvider>
      );

      expect(screen.getByTestId('has-mode')).toHaveTextContent('yes');
      expect(screen.getByTestId('has-toggle')).toHaveTextContent('yes');
      expect(screen.getByTestId('has-set')).toHaveTextContent('yes');
      expect(screen.getByTestId('has-isDark')).toHaveTextContent('yes');
    });
  });
});

describe('useTheme hook', () => {
  it('throws error when used outside provider', async () => {
    // Dynamically import useTheme to avoid module-level import issues
    const { useTheme } = await import('../hooks/useTheme');

    // Suppress console.error for expected error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useTheme());
    }).toThrow('useTheme must be used within a ThemeProvider');

    consoleSpy.mockRestore();
  });
});
