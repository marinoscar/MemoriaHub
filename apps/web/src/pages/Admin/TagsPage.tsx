/**
 * Admin → Tags (`/admin/settings/tagging`, embedded as {@link TagsContent}).
 *
 * Migrated onto the shared DataTable in issue #259 (epic #238): the hand-rolled
 * three-column `<Table>`, its inline row-edit mode, and its `window.confirm`
 * delete are gone. Renaming is now a small dialog (an inline `TextField` inside
 * a grid cell has no card-layout equivalent, and the DataTable's card renderer
 * is the whole point of the migration), and deleting routes through the row
 * action's own confirmation.
 *
 * ## The bespoke CSV round trip stays, and the generic export is disabled
 *
 * `GET /api/tag-labels/export` emits `id,name` — the importer needs those ids to
 * update or delete by row. Two export buttons producing different files, one of
 * which cannot be re-imported, is worse than one, so this table passes
 * `disableExport` (docs/specs/datatable.md §16.4) and keeps its own buttons.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Stack,
  TextField,
  Button,
  CircularProgress,
  Alert,
  IconButton,
  Collapse,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import {
  Edit as EditIcon,
  Delete as DeleteIcon,
  Download as DownloadIcon,
  Upload as UploadIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import {
  listTagLabels,
  createTagLabel,
  updateTagLabel,
  deleteTagLabel,
  exportTagLabels,
  importTagLabels,
} from '../../services/tagLabels';
import type { TagLabel, ImportResult } from '../../services/tagLabels';
import { DataTable, type DataTableRowAction } from '../../components/datatable';
import {
  TAG_LABELS_PAGE_SIZE,
  TAG_LABELS_TABLE_ID,
  buildTagColumns,
} from './tagsTable';

// ---------------------------------------------------------------------------
// Inner content (only rendered when user is admin)
// ---------------------------------------------------------------------------

export function TagsContent() {
  // ---- Tag label vocabulary state ----
  const [labels, setLabels] = useState<TagLabel[]>([]);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [labelsError, setLabelsError] = useState<string | null>(null);

  // Add form
  const [addName, setAddName] = useState('');
  const [addSaving, setAddSaving] = useState(false);

  // Rename dialog
  const [editLabel, setEditLabel] = useState<TagLabel | null>(null);
  const [editName, setEditName] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Delete
  const [deletingSaving, setDeletingSaving] = useState<string | null>(null);

  // Client-side pagination (the endpoint returns the whole vocabulary)
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(TAG_LABELS_PAGE_SIZE);

  // Export / import
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importErrorsOpen, setImportErrorsOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // ---- Load on mount ----
  const loadLabels = () => {
    setLabelsLoading(true);
    listTagLabels()
      .then(setLabels)
      .catch((err: unknown) => {
        setLabelsError(err instanceof Error ? err.message : 'Failed to load tag labels');
      })
      .finally(() => setLabelsLoading(false));
  };

  useEffect(() => {
    loadLabels();
  }, []);

  // ---- Handlers ----

  const handleAddLabel = async () => {
    if (!addName.trim()) return;
    setAddSaving(true);
    try {
      const label = await createTagLabel({ name: addName.trim() });
      setLabels((prev) => [...prev, label]);
      setAddName('');
    } catch (err) {
      setLabelsError(err instanceof Error ? err.message : 'Failed to add label');
    } finally {
      setAddSaving(false);
    }
  };

  const startEdit = (label: TagLabel) => {
    setEditLabel(label);
    setEditName(label.name);
  };

  const handleSaveEdit = async () => {
    if (!editLabel) return;
    setEditSaving(true);
    try {
      const updated = await updateTagLabel(editLabel.id, { name: editName });
      setLabels((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setEditLabel(null);
    } catch (err) {
      setLabelsError(err instanceof Error ? err.message : 'Failed to save label');
    } finally {
      setEditSaving(false);
    }
  };

  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    try {
      const updated = await updateTagLabel(id, { enabled });
      setLabels((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
    } catch (err) {
      setLabelsError(err instanceof Error ? err.message : 'Failed to update label');
    }
  };

  const handleDeleteLabel = async (id: string) => {
    setDeletingSaving(id);
    try {
      await deleteTagLabel(id);
      setLabels((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      setLabelsError(err instanceof Error ? err.message : 'Failed to delete label');
    } finally {
      setDeletingSaving(null);
    }
  };

  // ---- Export ----

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await exportTagLabels();
      const objectUrl = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `tag-labels-${dateStr}.csv`;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch (err) {
      setLabelsError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  // ---- Import ----

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so the same file can be picked again
    if (importInputRef.current) {
      importInputRef.current.value = '';
    }

    setImporting(true);
    setImportResult(null);
    setImportErrorsOpen(false);
    setLabelsError(null);

    try {
      const result = await importTagLabels(file);
      setImportResult(result);
      // Refresh the list to reflect changes
      loadLabels();
    } catch (err) {
      setLabelsError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  // ---- Table ----

  const columns = useMemo(
    () =>
      buildTagColumns({
        onToggleEnabled: (label, enabled) => void handleToggleEnabled(label.id, enabled),
      }),
    // Built once, deliberately: `handleToggleEnabled` closes over nothing that
    // changes — the `setLabels` / `setLabelsError` setters are stable and
    // `updateTagLabel` is a module import — so a fresh column array per render
    // would only churn every downstream `useMemo` keyed on `columns`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const rowActions = useMemo<DataTableRowAction<TagLabel>[]>(
    () => [
      {
        id: 'rename',
        label: 'Rename',
        icon: <EditIcon fontSize="small" />,
        onClick: (label) => startEdit(label),
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        disabled: (label) => deletingSaving === label.id,
        confirm: {
          title: 'Delete tag label?',
          description: (label) =>
            `"${label.name}" will be removed from the vocabulary, along with every AI-applied instance of it. This cannot be undone.`,
          confirmLabel: 'Delete',
        },
        onClick: (label) => void handleDeleteLabel(label.id),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deletingSaving],
  );

  // The endpoint returns the whole vocabulary; the PAGE slices it, so the
  // DataTable's "never paginate `rows` yourself" contract still holds.
  const pageRows = useMemo(
    () => labels.slice(page * pageSize, page * pageSize + pageSize),
    [labels, page, pageSize],
  );

  // Deleting the last row of the last page would otherwise strand the user on
  // an empty page with no way back except the footer's own arrows.
  useEffect(() => {
    if (page > 0 && page * pageSize >= labels.length) setPage(0);
  }, [labels.length, page, pageSize]);

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Tags
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Manage the AI tag vocabulary and run tagging backfills.
        </Typography>

        {/* ---- Tag Vocabulary ---- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Tag Vocabulary
          </Typography>

          {labelsError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setLabelsError(null)}>
              {labelsError}
            </Alert>
          )}

          {importResult && (
            <Alert
              severity={importResult.errors.length > 0 ? 'warning' : 'success'}
              sx={{ mb: 2 }}
              onClose={() => setImportResult(null)}
              action={
                importResult.errors.length > 0 ? (
                  <IconButton
                    size="small"
                    onClick={() => setImportErrorsOpen((o) => !o)}
                    aria-label={importErrorsOpen ? 'Collapse errors' : 'Expand errors'}
                  >
                    {importErrorsOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                  </IconButton>
                ) : undefined
              }
            >
              Imported: {importResult.created} created, {importResult.updated} updated,{' '}
              {importResult.deleted} deleted
              {importResult.errors.length > 0 && (
                <> — {importResult.errors.length} error(s)</>
              )}
              <Collapse in={importErrorsOpen}>
                <Box component="ul" sx={{ mt: 1, pl: 2 }}>
                  {importResult.errors.map((e, i) => (
                    <li key={i}>
                      Row {e.row}: {e.message}
                    </li>
                  ))}
                </Box>
              </Collapse>
            </Alert>
          )}

          {/* Toolbar: add + export/import */}
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ mb: 2, flexWrap: 'wrap' }}
          >
            {/* Add form */}
            <TextField
              label="Label name"
              size="small"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAddLabel();
              }}
              sx={{ flex: 1, minWidth: 180 }}
            />
            <Button
              variant="contained"
              disabled={!addName.trim() || addSaving}
              onClick={() => void handleAddLabel()}
              startIcon={addSaving ? <CircularProgress size={14} /> : undefined}
              sx={{ minWidth: 80, minHeight: 44 }}
            >
              Add
            </Button>

            {/* Spacer on larger screens */}
            <Box sx={{ flex: 1, display: { xs: 'none', sm: 'block' } }} />

            {/* Export */}
            <Button
              variant="outlined"
              startIcon={exporting ? <CircularProgress size={14} /> : <DownloadIcon />}
              disabled={exporting}
              onClick={() => void handleExport()}
              sx={{ minHeight: 44 }}
            >
              Export CSV
            </Button>

            {/* Import */}
            <input
              ref={importInputRef}
              type="file"
              accept=".csv"
              style={{ display: 'none' }}
              onChange={(e) => void handleImportFileChange(e)}
              aria-label="Import CSV file"
            />
            <Button
              variant="outlined"
              startIcon={importing ? <CircularProgress size={14} /> : <UploadIcon />}
              disabled={importing}
              onClick={() => importInputRef.current?.click()}
              sx={{ minHeight: 44 }}
            >
              Import CSV
            </Button>
          </Stack>

          {/* Import hint */}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            CSV columns: <code>id</code>, <code>name</code>, <code>delete</code> — leave{' '}
            <code>id</code> empty to create a new tag; set <code>delete=true</code> to remove by id.
          </Typography>

          {/*
            Rendered unconditionally with `loading` as a prop — see the module
            docblock's reference to docs/specs/datatable.md §18.4.
          */}
          <DataTable<TagLabel>
            columns={columns}
            rows={pageRows}
            rowId={(label) => label.id}
            tableId={TAG_LABELS_TABLE_ID}
            ariaLabel="Tag vocabulary"
            density="compact"
            loading={labelsLoading}
            emptyState={<span>No tag labels defined yet.</span>}
            pagination={{
              page,
              pageSize,
              total: labels.length,
              onPaginationChange: ({ page: nextPage, pageSize: nextPageSize }) => {
                setPage(nextPage);
                setPageSize(nextPageSize);
              },
              pageSizeOptions: [10, 25, 50, 100],
            }}
            rowActions={rowActions}
            // The bespoke `id,name` CSV round trip above is this table's export.
            disableExport
          />

          {/* Rename dialog — an inline TextField inside a grid cell has no
              card-layout equivalent, so the edit affordance is a dialog now. */}
          <Dialog open={!!editLabel} onClose={() => setEditLabel(null)} maxWidth="xs" fullWidth>
            <DialogTitle>Rename tag label</DialogTitle>
            <DialogContent>
              <TextField
                label="Label name"
                size="small"
                fullWidth
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveEdit();
                }}
                sx={{ mt: 1 }}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setEditLabel(null)} disabled={editSaving}>
                Cancel
              </Button>
              <Button
                variant="contained"
                onClick={() => void handleSaveEdit()}
                disabled={editSaving || !editName.trim()}
                startIcon={editSaving ? <CircularProgress size={14} /> : undefined}
              >
                Save
              </Button>
            </DialogActions>
          </Dialog>
        </Paper>

      </Box>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Page wrapper with admin guard
// ---------------------------------------------------------------------------

export default function TagsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <TagsContent />;
}
