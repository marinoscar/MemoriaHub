/**
 * Unit tests — useIntersectionObserver
 *
 * Covers the `rearmKey` option (issue #548): changing it re-creates the
 * observer, and because `observe()` always delivers an initial callback, a
 * sentinel that is still intersecting re-fires `onIntersect`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { useIntersectionObserver } from './useIntersectionObserver';

interface MockObserver {
  callback: IntersectionObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

const instances: MockObserver[] = [];
let intersecting = true;
const originalIO = global.IntersectionObserver;

class FakeIntersectionObserver {
  observe = vi.fn(() => {
    // Real observers always deliver an initial callback on observe().
    this.callback(
      [{ isIntersecting: intersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  });
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(public callback: IntersectionObserverCallback) {
    instances.push(this as unknown as MockObserver);
  }
}

function Harness({
  onIntersect,
  rearmKey,
  disabled,
}: {
  onIntersect: () => void;
  rearmKey?: unknown;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useIntersectionObserver(ref, onIntersect, { rearmKey, disabled });
  return <div ref={ref} data-testid="sentinel" />;
}

describe('useIntersectionObserver', () => {
  beforeEach(() => {
    instances.length = 0;
    intersecting = true;
    global.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    global.IntersectionObserver = originalIO;
  });

  it('invokes the callback when the sentinel is intersecting', () => {
    const onIntersect = vi.fn();
    render(<Harness onIntersect={onIntersect} rearmKey={1} />);
    expect(instances).toHaveLength(1);
    expect(onIntersect).toHaveBeenCalledTimes(1);
  });

  it('re-creates the observer and re-invokes the callback when rearmKey changes while still intersecting', () => {
    const onIntersect = vi.fn();
    const { rerender } = render(<Harness onIntersect={onIntersect} rearmKey={1} />);
    expect(instances).toHaveLength(1);
    expect(onIntersect).toHaveBeenCalledTimes(1);

    rerender(<Harness onIntersect={onIntersect} rearmKey={2} />);

    expect(instances).toHaveLength(2);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(onIntersect).toHaveBeenCalledTimes(2);
  });

  it('does not re-invoke the callback after a re-arm when the sentinel is no longer intersecting', () => {
    const onIntersect = vi.fn();
    const { rerender } = render(<Harness onIntersect={onIntersect} rearmKey={1} />);
    expect(onIntersect).toHaveBeenCalledTimes(1);

    intersecting = false;
    rerender(<Harness onIntersect={onIntersect} rearmKey={2} />);

    expect(instances).toHaveLength(2);
    expect(onIntersect).toHaveBeenCalledTimes(1);
  });

  it('does not re-create the observer when rearmKey is unchanged', () => {
    const onIntersect = vi.fn();
    const { rerender } = render(<Harness onIntersect={onIntersect} rearmKey={1} />);
    rerender(<Harness onIntersect={onIntersect} rearmKey={1} />);
    rerender(<Harness onIntersect={onIntersect} rearmKey={1} />);

    expect(instances).toHaveLength(1);
    expect(instances[0].disconnect).not.toHaveBeenCalled();
    expect(onIntersect).toHaveBeenCalledTimes(1);
  });

  it('creates no observer while disabled, even when rearmKey changes', () => {
    const onIntersect = vi.fn();
    const { rerender } = render(<Harness onIntersect={onIntersect} rearmKey={1} disabled />);
    rerender(<Harness onIntersect={onIntersect} rearmKey={2} disabled />);

    expect(instances).toHaveLength(0);
    expect(onIntersect).not.toHaveBeenCalled();
  });
});
