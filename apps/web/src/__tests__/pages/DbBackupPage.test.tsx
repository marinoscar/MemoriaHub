/**
 * The packaged Database Backup page as MemoriaHub binds it (RETRO-D4, #580).
 *
 * The page itself (policy panel, run history, restore dialog with the API's gates) is the
 * platform's and is tested in the package. What is this app's, and tested here: the binding hands
 * the page its `Sections` slot, the slot draws the restore runbook link at the top only (with both
 * RLS flags named), and the card and route keep the permission the API enforces.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { dbBackupAdminSections, type DbBackupSectionsProps } from '@marinoscar/platform-web/db-backup/ui';

const captured: { slots?: { Sections?: (props: DbBackupSectionsProps) => unknown } } = {};

vi.mock('@marinoscar/platform-web/db-backup/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@marinoscar/platform-web/db-backup/ui')>();
  return {
    ...actual,
    DbBackupPage: (props: { slots?: typeof captured.slots }) => {
      captured.slots = props.slots;
      return <div data-testid="packaged-db-backup-page" />;
    },
  };
});

import DbBackupPage, {
  RESTORE_RUNBOOK_PATH,
  RESTORE_RUNBOOK_URL,
  RestoreRunbookSection,
} from '../../platform/db-backup/DbBackupPage';
import { ADMIN_SECTIONS } from '../../config/adminSections';

const SECTION_PROPS: Omit<DbBackupSectionsProps, 'position'> = {
  config: null,
  runs: [],
  canWrite: true,
  canRestore: true,
  refresh: () => undefined,
};

describe('DbBackupPage (packaged binding)', () => {
  it('renders the packaged page with the runbook Sections slot', () => {
    render(<DbBackupPage />);
    expect(screen.getByTestId('packaged-db-backup-page')).toBeInTheDocument();
    expect(captured.slots?.Sections).toBe(RestoreRunbookSection);
  });

  it('draws the runbook link under the header, naming both RLS flags', () => {
    render(<RestoreRunbookSection position="top" {...SECTION_PROPS} />);
    const link = screen.getByRole('link', { name: 'database restore runbook' });
    expect(link).toHaveAttribute('href', RESTORE_RUNBOOK_URL);
    expect(RESTORE_RUNBOOK_URL).toContain(RESTORE_RUNBOOK_PATH);
    expect(screen.getByText('--enable-row-security')).toBeInTheDocument();
    expect(screen.getByText('PGOPTIONS=-c app.rls_bypass=on')).toBeInTheDocument();
  });

  it('draws nothing at the bottom', () => {
    const { container } = render(<RestoreRunbookSection position="bottom" {...SECTION_PROPS} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Database Backup registry card', () => {
  it('is the packaged card, once, at the same URL, gated on db_backup:read', () => {
    const cards = ADMIN_SECTIONS.flatMap((section) => section.cards).filter(
      (card) => card.path === '/admin/settings/db-backup',
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].permission).toBe('db_backup:read');
    expect(cards[0]).toBe(dbBackupAdminSections.operations[0]);
  });
});
