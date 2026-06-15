/**
 * leaflet-setup unit tests.
 *
 * Verifies that defaultIcon is an L.divIcon (not an L.Icon image-based icon)
 * and that its html contains inline SVG — the fix for the Vite/optimizeDeps
 * broken-image issue where PNG import URLs are served as text/javascript.
 *
 * Also verifies the CSS neutralization style tag is injected into the DOM.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock leaflet so the module can be imported without a real DOM canvas,
// but use actual divIcon/Icon constructors so we can inspect the result.
// ---------------------------------------------------------------------------
vi.mock('leaflet/dist/leaflet.css', () => ({}));

// We do NOT mock 'leaflet' itself — we let the real L.divIcon run.
// This validates the actual icon type at unit-test level.

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------
import { defaultIcon } from '../../../lib/leaflet-setup';
import L from 'leaflet';

describe('leaflet-setup defaultIcon', () => {
  it('should be an instance of L.DivIcon (not L.Icon)', () => {
    expect(defaultIcon).toBeInstanceOf(L.DivIcon);
  });

  it('should NOT be an instance of L.Icon.Default (no PNG images)', () => {
    expect(defaultIcon).not.toBeInstanceOf(L.Icon.Default);
  });

  it('should have className mh-marker-icon', () => {
    expect((defaultIcon.options as L.DivIconOptions).className).toBe('mh-marker-icon');
  });

  it('should have html that contains an <svg> element (not an <img>)', () => {
    const html = (defaultIcon.options as L.DivIconOptions).html as string;
    expect(html).toContain('<svg');
    expect(html).not.toContain('<img');
  });

  it('should NOT reference any external PNG image URLs', () => {
    const html = (defaultIcon.options as L.DivIconOptions).html as string;
    expect(html).not.toContain('.png');
    expect(html).not.toContain('marker-icon');
    expect(html).not.toContain('marker-shadow');
  });

  it('should have iconSize [25, 41]', () => {
    expect(defaultIcon.options.iconSize).toEqual([25, 41]);
  });

  it('should have iconAnchor [12, 41] (tip at bottom-center)', () => {
    expect(defaultIcon.options.iconAnchor).toEqual([12, 41]);
  });

  it('should have popupAnchor [1, -34]', () => {
    expect(defaultIcon.options.popupAnchor).toEqual([1, -34]);
  });
});

describe('leaflet-setup CSS injection', () => {
  it('should inject a <style> tag with id mh-marker-icon-styles into the document head', () => {
    const styleEl = document.getElementById('mh-marker-icon-styles');
    expect(styleEl).not.toBeNull();
    expect(styleEl?.tagName.toLowerCase()).toBe('style');
  });

  it('injected style should contain .mh-marker-icon with transparent background', () => {
    const styleEl = document.getElementById('mh-marker-icon-styles');
    expect(styleEl?.textContent).toContain('.mh-marker-icon');
    expect(styleEl?.textContent).toContain('background: transparent');
  });

  it('injected style should contain border: none to remove the divIcon box', () => {
    const styleEl = document.getElementById('mh-marker-icon-styles');
    expect(styleEl?.textContent).toContain('border: none');
  });

  it('should not inject duplicate style tags when imported multiple times', () => {
    // The module is already imported (above). Re-importing won't re-execute the
    // IIFE because modules are cached, but we confirm there is exactly one tag.
    const allStyleEls = document.querySelectorAll('#mh-marker-icon-styles');
    expect(allStyleEls.length).toBe(1);
  });
});
