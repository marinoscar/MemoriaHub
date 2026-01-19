import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
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
  ListItemSecondaryAction,
  IconButton,
  Chip,
  Alert,
} from '@mui/material';
import {
  CloudUpload as CloudUploadIcon,
  InsertDriveFile as FileIcon,
  Image as ImageIcon,
  Videocam as VideoIcon,
  Close as CloseIcon,
  CheckCircle as CheckIcon,
  Error as ErrorIcon,
  Refresh as RetryIcon,
} from '@mui/icons-material';
import { useUpload, SUPPORTED_FILE_TYPES, type UploadFileStatus } from '../../hooks';

interface UploadDialogProps {
  open: boolean;
  onClose: () => void;
  libraryId: string;
  libraryName: string;
  onUploadComplete?: () => void;
}

/**
 * Get icon for file type
 */
function getFileIcon(file: File) {
  if (file.type.startsWith('image/')) {
    return <ImageIcon />;
  }
  if (file.type.startsWith('video/')) {
    return <VideoIcon />;
  }
  return <FileIcon />;
}

/**
 * Get status icon for file
 */
function getStatusIcon(status: UploadFileStatus['status']) {
  switch (status) {
    case 'completed':
      return <CheckIcon color="success" />;
    case 'error':
      return <ErrorIcon color="error" />;
    default:
      return null;
  }
}

/**
 * Format file size
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Upload dialog component (Google Photos-style)
 */
export function UploadDialog({
  open,
  onClose,
  libraryId,
  libraryName,
  onUploadComplete,
}: UploadDialogProps) {
  const {
    files,
    isUploading,
    completedCount,
    errorCount,
    pendingCount,
    totalProgress,
    addFiles,
    removeFile,
    clearFiles,
    clearCompleted,
    startUpload,
    retryFailed,
  } = useUpload(libraryId);

  // Handle file drop
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const errors = addFiles(acceptedFiles);
      if (errors.length > 0) {
        // Could show a snackbar here
        console.warn('Some files were rejected:', errors);
      }
    },
    [addFiles]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: SUPPORTED_FILE_TYPES.reduce(
      (acc, type) => {
        acc[type] = [];
        return acc;
      },
      {} as Record<string, string[]>
    ),
    noClick: isUploading,
    noKeyboard: isUploading,
  });

  // Handle close - clear files if all completed
  const handleClose = () => {
    if (!isUploading) {
      if (completedCount > 0 && onUploadComplete) {
        onUploadComplete();
      }
      clearFiles();
      onClose();
    }
  };

  // Handle upload start
  const handleUpload = async () => {
    await startUpload();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: { minHeight: 400 },
      }}
    >
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          <Typography variant="h6" component="span">
            Upload to {libraryName}
          </Typography>
          {files.length > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {completedCount} of {files.length} completed
              {errorCount > 0 && ` (${errorCount} failed)`}
            </Typography>
          )}
        </Box>
        {!isUploading && (
          <IconButton onClick={handleClose} size="small">
            <CloseIcon />
          </IconButton>
        )}
      </DialogTitle>

      <DialogContent dividers>
        {/* Upload progress bar */}
        {isUploading && (
          <Box sx={{ mb: 2 }}>
            <LinearProgress variant="determinate" value={totalProgress} />
          </Box>
        )}

        {/* Dropzone */}
        {!isUploading && files.length === 0 && (
          <Box
            {...getRootProps()}
            sx={{
              border: '2px dashed',
              borderColor: isDragActive ? 'primary.main' : 'divider',
              borderRadius: 2,
              p: 4,
              textAlign: 'center',
              bgcolor: isDragActive ? 'action.hover' : 'transparent',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              '&:hover': {
                borderColor: 'primary.main',
                bgcolor: 'action.hover',
              },
            }}
          >
            <input {...getInputProps()} />
            <CloudUploadIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              {isDragActive ? 'Drop files here' : 'Drag and drop files here'}
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              or click to browse
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Supports images (JPEG, PNG, HEIC, etc.) and videos (MP4, MOV, etc.)
            </Typography>
          </Box>
        )}

        {/* File list */}
        {files.length > 0 && (
          <>
            {/* Add more files dropzone (smaller) */}
            {!isUploading && (
              <Box
                {...getRootProps()}
                sx={{
                  border: '1px dashed',
                  borderColor: isDragActive ? 'primary.main' : 'divider',
                  borderRadius: 1,
                  p: 1.5,
                  mb: 2,
                  textAlign: 'center',
                  cursor: 'pointer',
                  '&:hover': {
                    borderColor: 'primary.main',
                  },
                }}
              >
                <input {...getInputProps()} />
                <Typography variant="body2" color="text.secondary">
                  {isDragActive ? 'Drop to add more files' : 'Click or drag to add more files'}
                </Typography>
              </Box>
            )}

            {/* Error alert */}
            {errorCount > 0 && !isUploading && (
              <Alert
                severity="error"
                action={
                  <Button color="inherit" size="small" onClick={() => retryFailed()}>
                    <RetryIcon sx={{ mr: 0.5 }} /> Retry
                  </Button>
                }
                sx={{ mb: 2 }}
              >
                {errorCount} file{errorCount > 1 ? 's' : ''} failed to upload
              </Alert>
            )}

            {/* File list */}
            <List dense sx={{ maxHeight: 300, overflow: 'auto' }}>
              {files.map((fileStatus, index) => (
                <ListItem key={`${fileStatus.file.name}-${index}`}>
                  <ListItemIcon>{getFileIcon(fileStatus.file)}</ListItemIcon>
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="body2" noWrap sx={{ maxWidth: 200 }}>
                          {fileStatus.file.name}
                        </Typography>
                        {fileStatus.status === 'uploading' && (
                          <Chip label={`${fileStatus.progress}%`} size="small" color="primary" />
                        )}
                        {fileStatus.status === 'processing' && (
                          <Chip label="Processing" size="small" color="info" />
                        )}
                      </Box>
                    }
                    secondary={
                      fileStatus.error || formatFileSize(fileStatus.file.size)
                    }
                    secondaryTypographyProps={{
                      color: fileStatus.error ? 'error' : 'text.secondary',
                    }}
                  />
                  <ListItemSecondaryAction>
                    {getStatusIcon(fileStatus.status)}
                    {fileStatus.status === 'pending' && !isUploading && (
                      <IconButton
                        edge="end"
                        size="small"
                        onClick={() => removeFile(fileStatus.file)}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    )}
                    {fileStatus.status === 'uploading' && (
                      <Box sx={{ width: 40, display: 'inline-flex', justifyContent: 'center' }}>
                        <LinearProgress
                          variant="determinate"
                          value={fileStatus.progress}
                          sx={{ width: 30, height: 4, borderRadius: 2 }}
                        />
                      </Box>
                    )}
                  </ListItemSecondaryAction>
                </ListItem>
              ))}
            </List>
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        {completedCount > 0 && !isUploading && (
          <Button onClick={clearCompleted} color="inherit">
            Clear Completed
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={handleClose} disabled={isUploading}>
          {isUploading ? 'Uploading...' : completedCount === files.length && files.length > 0 ? 'Done' : 'Cancel'}
        </Button>
        {pendingCount > 0 && !isUploading && (
          <Button
            variant="contained"
            onClick={() => void handleUpload()}
            startIcon={<CloudUploadIcon />}
          >
            Upload {pendingCount} file{pendingCount > 1 ? 's' : ''}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
