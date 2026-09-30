/** Validation rules for POST /api/admin/broadcasts[/test] (issue #488). */
import { createBroadcastSchema } from './create-broadcast.dto';

const base = { title: 'Hello', body: 'World', channels: ['inbox'] };

function errors(input: unknown): string[] {
  const r = createBroadcastSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe('createBroadcastSchema', () => {
  it('accepts a minimal broadcast and defaults critical=false', () => {
    const r = createBroadcastSchema.parse(base);
    expect(r).toEqual({ title: 'Hello', body: 'World', channels: ['inbox'], critical: false });
  });

  it('enforces length limits', () => {
    expect(errors({ ...base, title: 'x'.repeat(121) })).not.toHaveLength(0);
    expect(errors({ ...base, title: 'x'.repeat(120) })).toHaveLength(0);
    expect(errors({ ...base, body: 'x'.repeat(2001) })).not.toHaveLength(0);
    expect(errors({ ...base, body: 'x'.repeat(2000) })).toHaveLength(0);
    expect(errors({ ...base, link: '/a', ctaLabel: 'x'.repeat(41) })).not.toHaveLength(0);
    expect(errors({ ...base, link: '/' + 'a'.repeat(500) })).not.toHaveLength(0);
    expect(errors({ ...base, title: '   ' })).not.toHaveLength(0);
  });

  it.each(['https://evil.test', '//evil.test', '/\\evil.test', 'relative/path', '/a b', 'javascript:alert(1)'])(
    'rejects the non-root-relative link %s',
    (link) => {
      expect(errors({ ...base, link })).not.toHaveLength(0);
    },
  );

  it('accepts a root-relative link with a query', () => {
    expect(errors({ ...base, link: '/memories?x=1' })).toHaveLength(0);
  });

  it('requires a non-empty, duplicate-free subset of inbox/push/email', () => {
    expect(errors({ ...base, channels: [] })).not.toHaveLength(0);
    expect(errors({ ...base, channels: ['sms'] })).not.toHaveLength(0);
    expect(errors({ ...base, channels: ['inbox', 'inbox'] })).not.toHaveLength(0);
    expect(errors({ ...base, channels: ['email'] })).toHaveLength(0);
    expect(errors({ ...base, channels: ['inbox', 'push', 'email'] })).toHaveLength(0);
  });

  it('critical requires inbox', () => {
    expect(errors({ ...base, channels: ['email'], critical: true }).join()).toMatch(/critical/);
    expect(errors({ ...base, channels: ['inbox'], critical: true })).toHaveLength(0);
  });

  it('push requires inbox', () => {
    expect(errors({ ...base, channels: ['push'] }).join()).toMatch(/push/);
  });

  it('ctaLabel requires link', () => {
    expect(errors({ ...base, ctaLabel: 'Go' }).join()).toMatch(/ctaLabel requires link/);
    expect(errors({ ...base, ctaLabel: 'Go', link: '/x' })).toHaveLength(0);
  });

  it('scheduledFor must be a future ISO timestamp with offset', () => {
    expect(errors({ ...base, scheduledFor: '2000-01-01T00:00:00Z' })).not.toHaveLength(0);
    expect(errors({ ...base, scheduledFor: 'tomorrow' })).not.toHaveLength(0);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const parsed = createBroadcastSchema.parse({ ...base, scheduledFor: future });
    expect(parsed.scheduledFor).toBeInstanceOf(Date);
  });
});
