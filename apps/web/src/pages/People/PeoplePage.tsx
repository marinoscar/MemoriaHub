import { useState, useEffect } from 'react';
import {
  Container,
  Box,
  Typography,
  Stack,
  Alert,
  Divider,
  Drawer,
  IconButton,
  TextField,
  CircularProgress,
  Grid,
  Button,
} from '@mui/material';
import {
  Close as CloseIcon,
  PhotoLibrary as PhotoLibraryIcon,
  Edit as EditIcon,
  Check as CheckIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircleContext } from '../../contexts/CircleContext';
import { usePeople, usePerson } from '../../hooks/usePeople';
import { PersonGrid } from '../../components/people/PersonGrid';
import { UnknownFacesReview } from '../../components/people/UnknownFacesReview';
import { FaceCrop } from '../../components/people/FaceCrop';
import type { PersonListItem } from '../../services/face';
import { listMedia } from '../../services/media';
import type { MediaItem } from '../../types/media';

// Person detail drawer content
function PersonDetailDrawer({
  personId,
  onClose,
  onRename,
  circleId,
}: {
  personId: string;
  onClose: () => void;
  onRename: (personId: string, name: string) => Promise<void>;
  circleId: string;
}) {
  const navigate = useNavigate();
  const { person, loading, error } = usePerson(personId);
  const [editing, setEditing] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [mediaMap, setMediaMap] = useState<Record<string, string>>({});

  // When person loads, seed the name field
  useEffect(() => {
    if (person) setNameValue(person.name ?? '');
  }, [person]);

  // Fetch media URLs for face crops
  useEffect(() => {
    if (!person || person.faces.length === 0) return;
    listMedia({ personId: person.id, circleId, pageSize: 50 })
      .then((resp) => {
        const map: Record<string, string> = {};
        resp.items.forEach((m: MediaItem) => {
          if (m.thumbnailUrl) map[m.id] = m.thumbnailUrl;
        });
        setMediaMap(map);
      })
      .catch(() => undefined);
  }, [person, circleId]);

  const handleSave = async () => {
    if (!nameValue.trim() || !person) return;
    setSaving(true);
    try {
      await onRename(person.id, nameValue.trim());
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !person) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {error ?? 'Person not found'}
      </Alert>
    );
  }

  return (
    <Box sx={{ width: { xs: 320, sm: 400 }, p: 2 }}>
      {/* Header */}
      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'center' }}>
        {editing ? (
          <>
            <TextField
              size="small"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              placeholder="Enter name"
              autoFocus
              sx={{ flexGrow: 1 }}
            />
            <IconButton
              size="small"
              onClick={() => void handleSave()}
              disabled={saving || !nameValue.trim()}
            >
              {saving ? <CircularProgress size={16} /> : <CheckIcon />}
            </IconButton>
          </>
        ) : (
          <>
            <Typography variant="h6" sx={{ flexGrow: 1 }}>
              {person.name ?? 'Unlabeled'}
            </Typography>
            <IconButton size="small" onClick={() => setEditing(true)} aria-label="Edit name">
              <EditIcon fontSize="small" />
            </IconButton>
          </>
        )}
        <IconButton size="small" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </IconButton>
      </Stack>

      <Divider sx={{ mb: 2 }} />

      {/* View photos button */}
      <Button
        variant="contained"
        fullWidth
        startIcon={<PhotoLibraryIcon />}
        onClick={() => navigate(`/media?personId=${person.id}&circleId=${circleId}`)}
        sx={{ mb: 2 }}
      >
        View their photos ({person.faces.length})
      </Button>

      {/* Face crops */}
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Face samples
      </Typography>
      <Grid container spacing={1}>
        {person.faces.slice(0, 12).map((face) => {
          const imgUrl = mediaMap[face.mediaItemId];
          return (
            <Grid key={face.faceId}>
              {imgUrl ? (
                <FaceCrop imageUrl={imgUrl} boundingBox={face.boundingBox} size={72} />
              ) : (
                <Box sx={{ width: 72, height: 72, bgcolor: 'grey.200', borderRadius: 1 }} />
              )}
            </Grid>
          );
        })}
      </Grid>
    </Box>
  );
}

export default function PeoplePage() {
  const { activeCircleId, activeCircleRole } = useCircleContext();
  const [selectedPerson, setSelectedPerson] = useState<PersonListItem | null>(null);

  const canCluster =
    activeCircleRole === 'circle_admin' || activeCircleRole === 'collaborator';

  // Labeled people (name != null)
  const {
    data: labeledData,
    loading: labeledLoading,
    error: labeledError,
    refresh: refreshLabeled,
    rename,
    cluster,
  } = usePeople(activeCircleId, { includeUnlabeled: false });

  // Unlabeled people
  const {
    data: unlabeledData,
    loading: unlabeledLoading,
    error: unlabeledError,
    refresh: refreshUnlabeled,
  } = usePeople(activeCircleId, { includeUnlabeled: true });

  // Filter unlabeled from the unlabeled fetch
  const unlabeledPeople = (unlabeledData?.items ?? []).filter((p) => p.isUnlabeled);
  const labeledPeople = labeledData?.items ?? [];

  const handlePersonClick = (person: PersonListItem) => {
    setSelectedPerson(person);
  };

  const handleCluster = async () => {
    const result = await cluster();
    await Promise.all([refreshLabeled(), refreshUnlabeled()]);
    return result;
  };

  const handleRename = async (personId: string, name: string) => {
    await rename(personId, name);
    await Promise.all([refreshLabeled(), refreshUnlabeled()]);
  };

  if (!activeCircleId) {
    return (
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Alert severity="info">Select a circle to view people.</Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      {/* Header */}
      <Stack direction="row" sx={{ mb: 3, alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="h4">People</Typography>
      </Stack>

      {(labeledError || unlabeledError) && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {labeledError ?? unlabeledError}
        </Alert>
      )}

      {/* Labeled people section */}
      <Box sx={{ mb: 4 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Named People ({labeledPeople.length})
        </Typography>
        <PersonGrid
          people={labeledPeople}
          onPersonClick={handlePersonClick}
          loading={labeledLoading}
          emptyMessage="No named people yet. Use 'Find People' then name the clusters below."
        />
      </Box>

      <Divider sx={{ mb: 3 }} />

      {/* Unknown faces section */}
      <UnknownFacesReview
        unlabeledPeople={unlabeledPeople}
        onPersonClick={handlePersonClick}
        onCluster={handleCluster}
        onRename={handleRename}
        canCluster={canCluster}
        loading={unlabeledLoading}
      />

      {/* Person detail drawer */}
      <Drawer
        anchor="right"
        open={selectedPerson !== null}
        onClose={() => setSelectedPerson(null)}
        ModalProps={{ keepMounted: false }}
      >
        {selectedPerson && activeCircleId && (
          <PersonDetailDrawer
            personId={selectedPerson.id}
            onClose={() => setSelectedPerson(null)}
            onRename={handleRename}
            circleId={activeCircleId}
          />
        )}
      </Drawer>
    </Container>
  );
}
