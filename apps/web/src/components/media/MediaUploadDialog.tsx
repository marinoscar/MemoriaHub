import { useState, useRef, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  LinearProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  IconButton,
  Alert,
  Chip,
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  CheckCircle as CheckIcon,
  Error as ErrorIcon,
  Close as CloseIcon,
  Replay as RetryIcon,
  ContentCopy as DuplicateIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import {
  initUpload,
  uploadPart,
  completeUpload,
  registerMedia,
  listMedia,
} from '../../services/media';
import { sha256File } from '../../utils/sha256';
import type { UploadPart, MediaType } from '../../types/media';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const MAX_RETRIES = 3;
const ALLOWED_TYPES = ['image/', 'video/'];

/**
 * 'duplicate' — file already exists in the library (pre-check hit or server
 *               dedup on registerMedia). No bytes were re-uploaded.
 */
type FileStatus = 'pending' | 'uploading' | 'success' | 'error' | 'duplicate';

interface FileState {
  file: File;
  status: FileStatus;
  progress: number; // 0–100
  error: string | null;
}

interface MediaUploadDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAllowedType(file: File): boolean {
  return ALLOWED_TYPES.some((prefix) => file.type.startsWith(prefix));
}

function detectMediaType(file: File): MediaType {
  return file.type.startsWith('video/') ? 'video' : 'photo';
}

/**
 * Upload a single file to storage and register it as a MediaItem.
 * Returns `true` when the server treated it as a duplicate (race condition
 * where another session registered the same hash between our pre-check and
 * completeUpload).
 */
async function uploadFileWithRetry(
  file: File,
  contentHash: string | null,
  onProgress: (pct: number) => void,
): Promise<{ deduplicated: boolean }> {
  // 1. Init upload
  const { objectId, partSize, totalParts, presignedUrls } = await initUpload({
    name: file.name,
    size: file.size,
    mimeType: file.type,
  });

  const parts: UploadPart[] = [];
  const urlMap = new Map<number, string>(
    presignedUrls.map((p) => [p.partNumber, p.url]),
  );

  // 2. Upload each part with retry
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.size);
    const chunk = file.slice(start, end);

    if (!urlMap.has(partNumber)) {
      throw new Error(
        `No presigned URL available for part ${partNumber}. ` +
          `File may be too large for the initial upload batch.`,
      );
    }

    const url = urlMap.get(partNumber)!;
    let etag: string | null = null;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        etag = await uploadPart(url, chunk);
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (!etag) {
      throw lastErr ?? new Error(`Failed to upload part ${partNumber}`);
    }

    parts.push({ partNumber, eTag: etag });
    onProgress(Math.round((partNumber / totalParts) * 90)); // 0–90% for parts
  }

  // 3. Complete multipart upload
  await completeUpload(objectId, parts);
  onProgress(95);

  // 4. Register as MediaItem (pass contentHash when available)
  const response = await registerMedia({
    storageObjectId: objectId,
    type: detectMediaType(file),
    source: 'web',
    originalFilename: file.name,
    ...(contentHash !== null ? { contentHash } : {}),
  });

  onProgress(100);

  return { deduplicated: response.deduplicated === true };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MediaUploadDialog({ open, onClose, onSuccess }: MediaUploadDialogProps) {
  const theme = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileStates, setFileStates] = useState<FileState[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const updateFileState = useCallback((index: number, patch: Partial<FileState>) => {
    setFileStates((prev) =>
      prev.map((fs, i) => (i === index ? { ...fs, ...patch } : fs)),
    );
  }, []);

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(event.target.files ?? []);
      if (selectedFiles.length === 0) return;

      setValidationError(null);

      const newStates: FileState[] = [];
      const errors: string[] = [];

      for (const file of selectedFiles) {
        if (!isAllowedType(file)) {
          errors.push(`${file.name}: not an image or video file`);
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          errors.push(`${file.name}: file exceeds 500 MB limit`);
          continue;
        }
        newStates.push({ file, status: 'pending', progress: 0, error: null });
      }

      if (errors.length > 0) {
        setValidationError(errors.join('\n'));
      }

      if (newStates.length > 0) {
        setFileStates((prev) => [...prev, ...newStates]);
      }

      // Reset input so the same file can be re-selected
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [],
  );

  const handleUploadAll = useCallback(async () => {
    const pending = fileStates.filter((fs) => fs.status === 'pending');
    if (pending.length === 0) return;

    setIsUploading(true);

    for (let i = 0; i < fileStates.length; i++) {
      if (fileStates[i].status !== 'pending') continue;

      updateFileState(i, { status: 'uploading', progress: 0 });

      try {
        // --- Client-side SHA-256 (streaming, never loads full file into memory)
        let contentHash: string | null = null;
        try {
          contentHash = await sha256File(fileStates[i].file);
        } catch {
          // Hash failure is non-fatal — fall back to uploading without a hash.
          contentHash = null;
        }

        // --- Pre-check: does the library already contain this hash?
        if (contentHash !== null) {
          const existing = await listMedia({ contentHash, pageSize: 1 });
          if (existing.items.length > 0) {
            // Already in the library — skip the upload entirely.
            updateFileState(i, { status: 'duplicate', progress: 100 });
            continue;
          }
        }

        // --- Upload + register
        const { deduplicated } = await uploadFileWithRetry(
          fileStates[i].file,
          contentHash,
          (pct) => {
            updateFileState(i, { progress: pct });
          },
        );

        // Server dedup race: another session registered the same hash first.
        if (deduplicated) {
          updateFileState(i, { status: 'duplicate', progress: 100 });
        } else {
          updateFileState(i, { status: 'success', progress: 100 });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        updateFileState(i, { status: 'error', error: message });
      }
    }

    setIsUploading(false);

    // Notify parent if every file is either success or duplicate (no errors, no pending)
    setFileStates((current) => {
      const allTerminal = current.every(
        (fs) => fs.status === 'success' || fs.status === 'duplicate',
      );
      if (allTerminal && current.length > 0) {
        onSuccess();
      }
      return current;
    });
  }, [fileStates, onSuccess, updateFileState]);

  const handleRetry = useCallback(
    async (index: number) => {
      updateFileState(index, { status: 'pending', error: null, progress: 0 });
    },
    [updateFileState],
  );

  const handleRemove = useCallback((index: number) => {
    setFileStates((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleClose = useCallback(() => {
    if (isUploading) return;
    setFileStates([]);
    setValidationError(null);
    onClose();
  }, [isUploading, onClose]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const successCount = fileStates.filter((fs) => fs.status === 'success').length;
  const duplicateCount = fileStates.filter((fs) => fs.status === 'duplicate').length;
  const errorCount = fileStates.filter((fs) => fs.status === 'error').length;
  const pendingCount = fileStates.filter((fs) => fs.status === 'pending').length;

  const allDone =
    fileStates.length > 0 &&
    fileStates.every(
      (fs) => fs.status === 'success' || fs.status === 'duplicate',
    );
  const hasErrors = errorCount > 0;
  const hasPending = pendingCount > 0;

  // ---------------------------------------------------------------------------
  // Summary message shown after the run completes
  // ---------------------------------------------------------------------------

  function buildSummary(): string {
    const parts: string[] = [];
    if (successCount > 0) parts.push(`${successCount} uploaded`);
    if (duplicateCount > 0)
      parts.push(`${duplicateCount} already in library`);
    if (errorCount > 0) parts.push(`${errorCount} failed`);
    return parts.join(', ');
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Upload Media
        <IconButton
          size="small"
          onClick={handleClose}
          disabled={isUploading}
          aria-label="Close upload dialog"
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {/* Drop zone / picker */}
        <Box
          sx={{
            border: `2px dashed ${theme.palette.divider}`,
            borderRadius: 2,
            p: 3,
            textAlign: 'center',
            cursor: 'pointer',
            mb: 2,
            '&:hover': {
              borderColor: theme.palette.primary.main,
              backgroundColor: theme.palette.action.hover,
            },
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadIcon sx={{ fontSize: 48, color: theme.palette.text.secondary, mb: 1 }} />
          <Typography variant="body1">
            Click to select images or videos
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Images and videos up to 500 MB each
          </Typography>
        </Box>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
          aria-label="Select media files"
        />

        {validationError && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {validationError}
          </Alert>
        )}

        {/* File list */}
        {fileStates.length > 0 && (
          <List dense>
            {fileStates.map((fs, i) => (
              <ListItem
                key={`${fs.file.name}-${i}`}
                sx={{ flexDirection: 'column', alignItems: 'stretch', mb: 1, px: 0 }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                  <ListItemIcon sx={{ minWidth: 36 }}>
                    {fs.status === 'success' && <CheckIcon color="success" />}
                    {fs.status === 'error' && <ErrorIcon color="error" />}
                    {fs.status === 'duplicate' && (
                      <DuplicateIcon
                        sx={{ color: theme.palette.info.main }}
                        aria-label="Already in library"
                      />
                    )}
                    {(fs.status === 'pending' || fs.status === 'uploading') && (
                      <Chip
                        label={fs.status === 'uploading' ? `${fs.progress}%` : 'queued'}
                        size="small"
                        variant="outlined"
                        sx={{ fontSize: '0.65rem' }}
                      />
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={
                      <Typography variant="body2" noWrap>
                        {fs.file.name}
                      </Typography>
                    }
                    secondary={
                      fs.status === 'duplicate' ? (
                        <Typography variant="caption" sx={{ color: theme.palette.info.main }}>
                          Already in library
                        </Typography>
                      ) : (
                        <Typography variant="caption">
                          {`${(fs.file.size / 1024 / 1024).toFixed(1)} MB`}
                        </Typography>
                      )
                    }
                    sx={{ flex: 1, mr: 1 }}
                  />
                  {fs.status === 'error' && (
                    <IconButton
                      size="small"
                      onClick={() => handleRetry(i)}
                      title="Retry"
                      aria-label={`Retry uploading ${fs.file.name}`}
                    >
                      <RetryIcon fontSize="small" />
                    </IconButton>
                  )}
                  {(fs.status === 'pending' || fs.status === 'error') && !isUploading && (
                    <IconButton
                      size="small"
                      onClick={() => handleRemove(i)}
                      title="Remove"
                      aria-label={`Remove ${fs.file.name} from queue`}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>

                {(fs.status === 'uploading' || fs.status === 'success') && (
                  <LinearProgress
                    variant="determinate"
                    value={fs.progress}
                    sx={{ mt: 0.5, ml: '36px' }}
                    color={fs.status === 'success' ? 'success' : 'primary'}
                  />
                )}

                {fs.status === 'error' && fs.error && (
                  <Typography
                    variant="caption"
                    color="error"
                    sx={{ ml: '36px', mt: 0.25, display: 'block' }}
                  >
                    {fs.error}
                  </Typography>
                )}
              </ListItem>
            ))}
          </List>
        )}

        {/* End-of-run summary */}
        {allDone && (
          <Alert severity={duplicateCount > 0 && successCount === 0 ? 'info' : 'success'}>
            {buildSummary()}. The library will refresh.
          </Alert>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose} disabled={isUploading}>
          {allDone ? 'Close' : 'Cancel'}
        </Button>
        {hasPending && (
          <Button
            variant="contained"
            onClick={handleUploadAll}
            disabled={isUploading}
            startIcon={<UploadIcon />}
          >
            {isUploading
              ? 'Uploading...'
              : `Upload ${fileStates.filter((f) => f.status === 'pending').length} file(s)`}
          </Button>
        )}
        {hasErrors && !isUploading && !hasPending && (
          <Button
            variant="contained"
            color="warning"
            onClick={() => {
              setFileStates((prev) =>
                prev.map((fs) =>
                  fs.status === 'error'
                    ? { ...fs, status: 'pending', error: null, progress: 0 }
                    : fs,
                ),
              );
            }}
          >
            Retry Failed
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
