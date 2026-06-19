import { useState, useEffect, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Stack,
  TextField,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Switch,
  FormControlLabel,
  IconButton,
  Collapse,
} from '@mui/material';
import {
  Edit as EditIcon,
  Save as SaveIcon,
  Cancel as CancelIcon,
  Delete as DeleteIcon,
  Download as DownloadIcon,
  Upload as UploadIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useCircles } from '../../hooks/useCircles';
import {
  listTagLabels,
  createTagLabel,
  updateTagLabel,
  deleteTagLabel,
  exportTagLabels,
  importTagLabels,
} from '../../services/tagLabels';
import type { TagLabel, ImportResult } from '../../services/tagLabels';
import { runTaggingBackfill } from '../../services/tagging';

// ---------------------------------------------------------------------------
// Inner content (only rendered when user is admin)
// ---------------------------------------------------------------------------

function TagsContent() {
  // ---- Tag label vocabulary state ----
  const [labels, setLabels] = useState<TagLabel[]>([]);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [labelsError, setLabelsError] = useState<string | null>(null);

  // Add form
  const [addName, setAddName] = useState('');
  const [addSaving, setAddSaving] = useState(false);

  // Inline edit form
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Delete
  const [deletingSaving, setDeletingSaving] = useState<string | null>(null);

  // Export / import
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importErrorsOpen, setImportErrorsOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // ---- Backfill state ----
  const { circles, fetchCircles } = useCircles();
  const [backfillCircleId, setBackfillCircleId] = useState('');
  const [backfillFrom, setBackfillFrom] = useState('');
  const [backfillTo, setBackfillTo] = useState('');
  const [backfillForce, setBackfillForce] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

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

  useEffect(() => {
    void fetchCircles();
  }, [fetchCircles]);

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
    setEditId(label.id);
    setEditName(label.name);
  };

  const handleSaveEdit = async () => {
    if (!editId) return;
    setEditSaving(true);
    try {
      const updated = await updateTagLabel(editId, { name: editName });
      setLabels((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setEditId(null);
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
    if (!window.confirm('Delete this tag label? This cannot be undone.')) return;
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

  // ---- Backfill ----

  const handleRunBackfill = async () => {
    if (!backfillCircleId) return;
    setBackfillLoading(true);
    setBackfillResult(null);
    setBackfillError(null);
    try {
      const result = await runTaggingBackfill({
        circleId: backfillCircleId,
        from: backfillFrom || undefined,
        to: backfillTo || undefined,
        force: backfillForce,
      });
      setBackfillResult(`Enqueued ${result.enqueued} photos for tagging.`);
    } catch (err) {
      setBackfillError(err instanceof Error ? err.message : 'Failed to run backfill');
    } finally {
      setBackfillLoading(false);
    }
  };

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

          {/* Table */}
          {labelsLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Enabled</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {labels.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} align="center">
                        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                          No tag labels defined yet.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                  {labels.map((label) =>
                    editId === label.id ? (
                      // Inline edit mode
                      <TableRow key={label.id}>
                        <TableCell>
                          <TextField
                            size="small"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleSaveEdit();
                              if (e.key === 'Escape') setEditId(null);
                            }}
                            autoFocus
                          />
                        </TableCell>
                        <TableCell />
                        <TableCell align="right">
                          <IconButton
                            size="small"
                            onClick={() => void handleSaveEdit()}
                            disabled={editSaving}
                            aria-label="Save"
                          >
                            {editSaving ? <CircularProgress size={14} /> : <SaveIcon />}
                          </IconButton>
                          <IconButton
                            size="small"
                            onClick={() => setEditId(null)}
                            aria-label="Cancel"
                          >
                            <CancelIcon />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ) : (
                      // Read mode
                      <TableRow key={label.id}>
                        <TableCell>{label.name}</TableCell>
                        <TableCell>
                          <Switch
                            size="small"
                            checked={label.enabled}
                            onChange={(e) => void handleToggleEnabled(label.id, e.target.checked)}
                            aria-label={`Toggle ${label.name}`}
                          />
                        </TableCell>
                        <TableCell align="right">
                          <IconButton
                            size="small"
                            onClick={() => startEdit(label)}
                            aria-label={`Edit ${label.name}`}
                          >
                            <EditIcon />
                          </IconButton>
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => void handleDeleteLabel(label.id)}
                            disabled={deletingSaving === label.id}
                            aria-label={`Delete ${label.name}`}
                          >
                            {deletingSaving === label.id ? (
                              <CircularProgress size={14} />
                            ) : (
                              <DeleteIcon />
                            )}
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ),
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>

        {/* ---- Tagging Backfill ---- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Run Tagging Backfill
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queue AI tagging for existing photos. Requires auto-tagging to be enabled on the circle.
          </Typography>

          <FormControl size="small" fullWidth sx={{ mb: 2 }}>
            <InputLabel>Circle</InputLabel>
            <Select
              label="Circle"
              value={backfillCircleId}
              onChange={(e) => setBackfillCircleId(e.target.value)}
            >
              <MenuItem value="">Select circle</MenuItem>
              {circles.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
            <TextField
              label="From date"
              type="date"
              size="small"
              value={backfillFrom}
              onChange={(e) => setBackfillFrom(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="To date"
              type="date"
              size="small"
              value={backfillTo}
              onChange={(e) => setBackfillTo(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ flex: 1 }}
            />
          </Stack>

          <FormControlLabel
            control={
              <Switch
                checked={backfillForce}
                onChange={(e) => setBackfillForce(e.target.checked)}
              />
            }
            label="Force (reprocess already-tagged photos)"
            sx={{ mb: 2, display: 'block' }}
          />

          {backfillResult && (
            <Alert severity="success" sx={{ mb: 2 }}>
              {backfillResult}
            </Alert>
          )}
          {backfillError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setBackfillError(null)}>
              {backfillError}
            </Alert>
          )}

          <Button
            variant="contained"
            disabled={!backfillCircleId || backfillLoading}
            onClick={() => void handleRunBackfill()}
            startIcon={backfillLoading ? <CircularProgress size={16} /> : undefined}
          >
            Run Backfill
          </Button>
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
