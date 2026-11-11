// =============================================================================
// A fake admin port: a plain-HTML data table, a header and an in-memory settings hook
// =============================================================================
//
// The real ones belong to the host (the web edition binds the platform's). A page
// test that does not need the platform table's mechanics (column picker, virtual
// rows, the card layout) renders against these, so the package's tests import
// nothing from the platform.
// =============================================================================

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';

import type {
  MemoriahubAdminPageHeaderProps,
  MemoriahubAdminPort,
  MemoriahubDataTableProps,
  MemoriahubSystemSettings,
  MemoriahubSystemSettingsState,
} from '../headless/admin.js';

function FakeDataTable<Row>(props: MemoriahubDataTableProps<Row>): ReactNode {
  const { columns, rows, rowId, ariaLabel, loading, emptyState, rowActions, pagination } = props;
  const [confirming, setConfirming] = useState<{ actionId: string; row: Row } | null>(null);
  const cell = (col: (typeof columns)[number], row: Row): ReactNode => (col.render ? col.render(row) : (col.value?.(row) ?? ''));
  const pending = confirming ? rowActions?.find((a) => a.id === confirming.actionId) : undefined;
  const confirmOptions = pending && typeof pending.confirm === 'object' ? pending.confirm : undefined;
  const description =
    confirmOptions && confirming
      ? typeof confirmOptions.description === 'function'
        ? confirmOptions.description(confirming.row)
        : confirmOptions.description
      : undefined;
  return (
    <div>
      <table aria-label={ariaLabel} aria-busy={loading ? 'true' : undefined}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.id}>{c.label}</th>
            ))}
            {rowActions?.length ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !loading ? (
            <tr>
              <td colSpan={columns.length + 1}>{emptyState}</td>
            </tr>
          ) : null}
          {rows.map((row) => (
            <tr key={rowId(row)}>
              {columns.map((c) => (
                <td key={c.id}>{cell(c, row)}</td>
              ))}
              {rowActions?.length ? (
                <td>
                  {rowActions.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      disabled={a.disabled?.(row) ?? false}
                      onClick={() => (a.confirm ? setConfirming({ actionId: a.id, row }) : a.onClick(row))}
                    >
                      {a.label}
                    </button>
                  ))}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {pending && confirming ? (
        <div role="dialog" aria-label={confirmOptions?.title ?? pending.label}>
          {description ? <p>{description}</p> : null}
          <button
            type="button"
            onClick={() => {
              const { row } = confirming;
              setConfirming(null);
              pending.onClick(row);
            }}
          >
            {confirmOptions?.confirmLabel ?? 'Confirm'}
          </button>
          <button type="button" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {pagination ? (
        <div>
          <span>
            Page {pagination.page + 1} of {Math.max(1, Math.ceil(pagination.total / pagination.pageSize))}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function FakeAdminPageHeader({ title, icon, titleAdornment, description, actions }: MemoriahubAdminPageHeaderProps): ReactNode {
  return (
    <header>
      <a href="/admin/settings">&larr; Back to Settings</a>
      {icon}
      <h1>{title}</h1>
      {titleAdornment}
      {description ? <p>{description}</p> : null}
      {actions}
    </header>
  );
}

function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)
        ? mergeDeep(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

/**
 * The fake admin port and what its settings hook recorded.
 *
 * @stability experimental
 */
export interface FakeAdminPort {
  /** The port to hand to the fake host. */
  port: MemoriahubAdminPort;
  /** Every patch `updateSettings` received, in order. */
  settingsUpdates: Array<Partial<MemoriahubSystemSettings>>;
  /** Makes the next `updateSettings` call reject with this message (`null` clears it). */
  failNextUpdate(message: string | null): void;
}

/**
 * Creates the fake admin port.
 *
 * @param initial - the settings document; `null` leaves the hook in its loading state.
 * @param loadError - with `initial` `null`, the message the hook reports as its load failure.
 * @returns the port and its recordings.
 *
 * @stability experimental
 */
export function createFakeAdminPort(initial: Partial<MemoriahubSystemSettings> | null = {}, loadError: string | null = null): FakeAdminPort {
  const settingsUpdates: Array<Partial<MemoriahubSystemSettings>> = [];
  let failure: string | null = null;

  function useFakeSystemSettings(): MemoriahubSystemSettingsState {
    const [settings, setSettings] = useState<MemoriahubSystemSettings | null>(
      initial === null ? null : ({ features: {}, version: 1, ...initial } as MemoriahubSystemSettings),
    );
    const [isSaving, setIsSaving] = useState(false);
    const updateSettings = useCallback(async (updates: Partial<MemoriahubSystemSettings>) => {
      settingsUpdates.push(updates);
      if (failure) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
      setIsSaving(true);
      setSettings((current) =>
        current ? (mergeDeep(current as unknown as Record<string, unknown>, updates as Record<string, unknown>) as unknown as MemoriahubSystemSettings) : current,
      );
      setIsSaving(false);
    }, []);
    const refresh = useCallback(async () => undefined, []);
    return { settings, isLoading: settings === null && loadError === null, error: settings === null ? loadError : null, isSaving, updateSettings, refresh };
  }

  return {
    port: { DataTable: FakeDataTable, AdminPageHeader: FakeAdminPageHeader, useSystemSettings: useFakeSystemSettings },
    settingsUpdates,
    failNextUpdate: (message) => {
      failure = message;
    },
  };
}
