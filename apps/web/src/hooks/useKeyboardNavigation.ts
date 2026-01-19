import { useEffect } from 'react';

interface UseKeyboardNavigationOptions {
  /** Handler for next navigation */
  onNext: () => void;
  /** Handler for previous navigation */
  onPrevious: () => void;
  /** Handler for close action */
  onClose: () => void;
  /** Whether keyboard navigation is enabled */
  enabled: boolean;
}

/**
 * Hook for keyboard navigation in lightbox
 * Handles arrow keys for navigation and Escape for close
 */
export function useKeyboardNavigation({
  onNext,
  onPrevious,
  onClose,
  enabled,
}: UseKeyboardNavigationOptions): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          onPrevious();
          break;
        case 'ArrowRight':
        case 'ArrowDown':
        case ' ': // Space
          event.preventDefault();
          onNext();
          break;
        case 'Escape':
          event.preventDefault();
          onClose();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, onNext, onPrevious, onClose]);
}
