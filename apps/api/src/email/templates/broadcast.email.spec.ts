/** Admin broadcast email template (epic #481, issue #488). Pure rendering. */
import { broadcastEmail, splitParagraphs } from './broadcast.email';
import { TEMPLATES } from './index';

describe('broadcastEmail', () => {
  it('uses the title as subject and renders each paragraph', () => {
    const out = broadcastEmail({ title: 'Maintenance tonight', body: 'Line one.\n\nLine two\ncontinued.' });
    expect(out.subject).toBe('Maintenance tonight');
    expect(out.html).toContain('<p style="margin:0 0 16px 0;">Line one.</p>');
    expect(out.html).toContain('Line two continued.');
    expect(out.text).toContain('Line one.\n\nLine two continued.');
  });

  it('HTML-escapes admin-typed content (body and title)', () => {
    const out = broadcastEmail({ title: '<b>x</b>', body: '<script>alert(1)</script> & "q"' });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
    expect(out.html).not.toContain('<b>x</b>');
  });

  it('renders a CTA only when a URL is given, defaulting the label', () => {
    expect(broadcastEmail({ title: 't', body: 'b' }).html).not.toContain('Open MemoriaHub');
    const withUrl = broadcastEmail({ title: 't', body: 'b', ctaUrl: 'https://app.test/status' });
    expect(withUrl.html).toContain('https://app.test/status');
    expect(withUrl.html).toContain('Open MemoriaHub');
    expect(withUrl.text).toContain('Open MemoriaHub: https://app.test/status');
    const labelled = broadcastEmail({ title: 't', body: 'b', ctaUrl: 'https://app.test/s', ctaLabel: 'See status' });
    expect(labelled.html).toContain('See status');
  });

  it('adds the critical notice only for a critical broadcast', () => {
    expect(broadcastEmail({ title: 't', body: 'b' }).text).not.toMatch(/marked important/);
    const c = broadcastEmail({ title: 't', body: 'b', critical: true });
    expect(c.html).toMatch(/marked important/);
    expect(c.text).toMatch(/marked important/);
  });

  it('is registered in the template registry', () => {
    expect(TEMPLATES.broadcast).toBe(broadcastEmail);
  });

  it('splitParagraphs drops empty blocks', () => {
    expect(splitParagraphs('\n\n a \n\n\n\n b\n')).toEqual(['a', 'b']);
  });
});
