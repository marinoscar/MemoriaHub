import { SECURITY_SCHEMES } from './document';
import {
  DEFAULT_SCALAR_CDN,
  SESSION_SECURITY_SCHEME,
  renderDocsPage,
} from './docs-page';

const options = {
  title: 'MemoriaHub API Reference',
  version: '1.2.3',
  specUrl: '/api/openapi.json',
};

describe('renderDocsPage', () => {
  it('names the session scheme the document actually declares', () => {
    // These live in separate modules on purpose — docs-page renders a string and
    // must not pull the document builder (and Nest) in with it — so the coupling
    // is asserted here instead of enforced by an import.
    expect(SESSION_SECURITY_SCHEME).toBe(SECURITY_SCHEMES.JWT_AUTH);
  });

  it('points the reference at the canonical spec rather than inlining it', () => {
    const html = renderDocsPage(options);
    expect(html).toContain('"url":"/api/openapi.json"');
    expect(html).toContain('href="/api/openapi.json"');
  });

  it('loads the reference bundle from the default CDN', () => {
    expect(renderDocsPage(options)).toContain(`<script src="${DEFAULT_SCALAR_CDN}">`);
  });

  it('lets an air-gapped deployment point the bundle somewhere else', () => {
    const html = renderDocsPage({ ...options, cdn: 'https://assets.internal/scalar.js' });
    expect(html).toContain('<script src="https://assets.internal/scalar.js">');
    expect(html).not.toContain(DEFAULT_SCALAR_CDN);
  });

  it('honours API_DOCS_CDN', () => {
    const previous = process.env.API_DOCS_CDN;
    process.env.API_DOCS_CDN = 'https://cdn.example.test/bundle.js';
    try {
      expect(renderDocsPage(options)).toContain('https://cdn.example.test/bundle.js');
    } finally {
      if (previous === undefined) delete process.env.API_DOCS_CDN;
      else process.env.API_DOCS_CDN = previous;
    }
  });

  describe('one-click session auth', () => {
    const html = renderDocsPage(options);

    it('exchanges the refresh cookie for an access token', () => {
      expect(html).toContain("fetch('/api/auth/refresh'");
      // The cookie is path-scoped to /api/auth, so it rides along only with
      // credentials: 'include'. Without this the whole feature silently no-ops.
      expect(html).toContain("credentials: 'include'");
    });

    it('pre-authorizes the client before mounting it', () => {
      const fetchAt = html.indexOf('fetchSessionToken');
      const mountAt = html.indexOf('createApiReference');
      expect(fetchAt).toBeGreaterThan(-1);
      expect(fetchAt).toBeLessThan(mountAt);
      expect(html).toContain('preferredSecurityScheme');
    });

    it('tells a signed-out reader what to do instead of failing silently', () => {
      expect(html).toContain('Not signed in');
    });
  });

  describe('escaping', () => {
    it('escapes interpolated text into the markup', () => {
      const html = renderDocsPage({ ...options, version: '<img src=x onerror=alert(1)>' });
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('cannot be broken out of by a value containing a closing script tag', () => {
      const html = renderDocsPage({ ...options, specUrl: '/spec</script><script>evil()' });
      expect(html).not.toContain('</script><script>evil()');
    });
  });
});
