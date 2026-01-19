import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardNavigation } from './useKeyboardNavigation';

describe('useKeyboardNavigation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onNext when ArrowRight is pressed', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onClose = vi.fn();

    renderHook(() => useKeyboardNavigation({
      onNext,
      onPrevious,
      onClose,
      enabled: true,
    }));

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    window.dispatchEvent(event);

    expect(onNext).toHaveBeenCalled();
    expect(onPrevious).not.toHaveBeenCalled();
  });

  it('calls onNext when ArrowDown is pressed', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onClose = vi.fn();

    renderHook(() => useKeyboardNavigation({
      onNext,
      onPrevious,
      onClose,
      enabled: true,
    }));

    const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
    window.dispatchEvent(event);

    expect(onNext).toHaveBeenCalled();
  });

  it('calls onNext when Space is pressed', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onClose = vi.fn();

    renderHook(() => useKeyboardNavigation({
      onNext,
      onPrevious,
      onClose,
      enabled: true,
    }));

    const event = new KeyboardEvent('keydown', { key: ' ' });
    window.dispatchEvent(event);

    expect(onNext).toHaveBeenCalled();
  });

  it('calls onPrevious when ArrowLeft is pressed', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onClose = vi.fn();

    renderHook(() => useKeyboardNavigation({
      onNext,
      onPrevious,
      onClose,
      enabled: true,
    }));

    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
    window.dispatchEvent(event);

    expect(onPrevious).toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('calls onPrevious when ArrowUp is pressed', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onClose = vi.fn();

    renderHook(() => useKeyboardNavigation({
      onNext,
      onPrevious,
      onClose,
      enabled: true,
    }));

    const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
    window.dispatchEvent(event);

    expect(onPrevious).toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onClose = vi.fn();

    renderHook(() => useKeyboardNavigation({
      onNext,
      onPrevious,
      onClose,
      enabled: true,
    }));

    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    window.dispatchEvent(event);

    expect(onClose).toHaveBeenCalled();
  });

  it('does not call handlers when enabled is false', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onClose = vi.fn();

    renderHook(() => useKeyboardNavigation({
      onNext,
      onPrevious,
      onClose,
      enabled: false,
    }));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onNext).not.toHaveBeenCalled();
    expect(onPrevious).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cleans up event listener on unmount', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onClose = vi.fn();

    const { unmount } = renderHook(() => useKeyboardNavigation({
      onNext,
      onPrevious,
      onClose,
      enabled: true,
    }));

    unmount();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    expect(onNext).not.toHaveBeenCalled();
  });
});
