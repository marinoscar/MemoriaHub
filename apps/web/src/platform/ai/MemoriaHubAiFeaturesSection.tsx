/**
 * MemoriaHub's AI feature selections, as a section of the platform's admin AI page
 * (`/admin/settings/ai`, RETRO-E4 #607).
 *
 * The platform page (`AiConfigPage`) owns the switch, the key policy, the providers and their
 * deployment keys and the limits. What it has no word for is WHICH provider and model serve each
 * MemoriaHub feature (the `ai.features.*` extension of the `ai` settings namespace): agentic
 * search, photo and video tagging, the semantic-search embeddings, the Picture Enhancer, memory
 * titles and video speech-to-text. This section edits them through
 * `/api/admin/memoriahub-ai/*` (`ai_config:read` to see, `ai_config:write` to change; the controls
 * are disabled without the write permission, the API enforces it).
 *
 * THESE FEATURES RUN THROUGH THE PLATFORM AI RUNTIME (RETRO-E2, #601): the deployment key saved above,
 * the "AI enabled" switch, the key policy and the AI Models catalogue all govern them. The section says
 * so, and is drawn in the page's bottom `Sections` slot, so it stays reachable while AI is off.
 *
 * Not `DefaultAiModelPicker`: that card is the per-user default (a fixed "Default model" title,
 * responses-capable models only), while a MemoriaHub feature needs embedding, image-edit and
 * speech-to-text lists too (a seam gap recorded in docs/platform-adoption/local-exceptions.md).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { aiErrorText } from '@marinoscar/platform-web/ai/ui';

import { usePermissions } from '../../hooks/usePermissions';
import {
  getAiModelsFor,
  getAiSettings,
  putAiFeature,
  testAiEmbedding,
  testAiProvider,
  type AiFeatureKey,
  type AiModelCapability,
  type AiProvider,
  type AiSettingsResponse,
} from '../../services/ai';

/** One selectable MemoriaHub feature. */
export interface MemoriaHubAiFeature {
  key: AiFeatureKey;
  title: string;
  description: string;
  /** Which model list the provider offers for it. */
  capability: AiModelCapability;
  /** Whether a selection can be cleared (the whole-or-null features). */
  clearable: boolean;
  /** How "Test" probes the selection; absent: no test. */
  test?: 'chat' | 'embedding';
}

/** The features, in the order the section lists them. */
export const MEMORIAHUB_AI_FEATURES: readonly MemoriaHubAiFeature[] = [
  {
    key: 'search',
    title: 'Agentic search',
    description: 'The conversational search assistant (chat with tools).',
    capability: 'chat',
    clearable: false,
    test: 'chat',
  },
  {
    key: 'tagging',
    title: 'Photo and video tagging',
    description: 'Describes and tags photos and video frames from the tag vocabulary (a vision model).',
    capability: 'chat',
    clearable: false,
    test: 'chat',
  },
  {
    key: 'embedding',
    title: 'Search by meaning',
    description: 'Embeds descriptions for semantic search. Storage expects 1536-dimension vectors.',
    capability: 'embedding',
    clearable: false,
    test: 'embedding',
  },
  {
    key: 'enhance',
    title: 'AI Picture Enhancer',
    description: 'The image-edit model behind photo enhancement. Clearing it turns enhancement off.',
    capability: 'image',
    clearable: true,
  },
  {
    key: 'memories',
    title: 'Memory titles',
    description: 'Writes memory titles and stories. Cleared: memories use template titles.',
    capability: 'chat',
    clearable: true,
    test: 'chat',
  },
  {
    key: 'transcription',
    title: 'Video speech-to-text',
    description: 'Transcribes the opening seconds of a video for tagging. Cleared: videos are tagged from frames only.',
    capability: 'transcription',
    clearable: true,
  },
];

const PROVIDER_NAMES: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic' };
const providerName = (id: string) => PROVIDER_NAMES[id] ?? id;

interface FeatureCardProps {
  feature: MemoriaHubAiFeature;
  selection: { provider: string | null; model: string | null } | null | undefined;
  providers: AiProvider[];
  canWrite: boolean;
  onSaved: () => void;
}

function FeatureCard({ feature, selection, providers, canWrite, onSaved }: FeatureCardProps) {
  const [provider, setProvider] = useState(selection?.provider ?? '');
  const [model, setModel] = useState(selection?.model ?? '');
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [busy, setBusy] = useState<'save' | 'clear' | 'test' | null>(null);
  const [message, setMessage] = useState<{ severity: 'success' | 'error' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    setProvider(selection?.provider ?? '');
    setModel(selection?.model ?? '');
  }, [selection?.provider, selection?.model]);

  useEffect(() => {
    if (!provider) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    getAiModelsFor(provider, feature.capability)
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, feature.capability]);

  const status = providers.find((p) => p.provider === provider);
  const keyMissing = provider !== '' && !(status?.configured && status.enabled);
  // A saved model the provider no longer lists is still shown, so the select never goes blank.
  const options = model && !models.includes(model) ? [model, ...models] : models;
  const saved = selection?.provider && selection?.model ? `${providerName(selection.provider)} · ${selection.model}` : null;

  const run = async (kind: 'save' | 'clear' | 'test', action: () => Promise<void>) => {
    setBusy(kind);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setMessage({ severity: 'error', text: aiErrorText(err, 'The request failed.') });
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      await putAiFeature(feature.key, { provider, model });
      setMessage({ severity: 'success', text: 'Saved.' });
      onSaved();
    });

  const clear = () =>
    run('clear', async () => {
      await putAiFeature(feature.key, { provider: null, model: null });
      setProvider('');
      setModel('');
      setMessage({ severity: 'success', text: 'Cleared.' });
      onSaved();
    });

  const test = () =>
    run('test', async () => {
      const result =
        feature.test === 'embedding' ? await testAiEmbedding({ provider, model }) : await testAiProvider({ provider, model });
      if (!result.ok) {
        setMessage({ severity: 'error', text: result.error ?? 'Test failed.' });
        return;
      }
      const warning = 'warning' in result ? (result as { warning?: string }).warning : undefined;
      setMessage(warning ? { severity: 'warning', text: warning } : { severity: 'success', text: 'Connection successful.' });
    });

  const idPrefix = `memoriahub-ai-${feature.key}`;

  return (
    <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-labelledby={`${idPrefix}-title`}>
      <Stack direction="row" spacing={1} sx={{ mb: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <Typography id={`${idPrefix}-title`} variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
          {feature.title}
        </Typography>
        <Chip size="small" label={saved ?? 'Not set'} color={saved ? 'primary' : 'default'} variant="outlined" />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {feature.description}
      </Typography>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <FormControl size="small" fullWidth disabled={!canWrite}>
          <InputLabel id={`${idPrefix}-provider-label`}>Provider</InputLabel>
          <Select
            labelId={`${idPrefix}-provider-label`}
            label="Provider"
            value={provider}
            onChange={(e) => {
              setProvider(String(e.target.value));
              setModel('');
              setMessage(null);
            }}
          >
            <MenuItem value="">
              <em>Select a provider</em>
            </MenuItem>
            {providers.map((p) => (
              <MenuItem key={p.provider} value={p.provider}>
                {providerName(p.provider)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl size="small" fullWidth disabled={!canWrite || !provider || modelsLoading}>
          <InputLabel id={`${idPrefix}-model-label`}>Model</InputLabel>
          <Select
            labelId={`${idPrefix}-model-label`}
            label="Model"
            value={options.includes(model) ? model : ''}
            onChange={(e) => {
              setModel(String(e.target.value));
              setMessage(null);
            }}
          >
            {options.length === 0 && (
              <MenuItem value="" disabled>
                {modelsLoading ? 'Loading models…' : 'No models available'}
              </MenuItem>
            )}
            {options.map((m) => (
              <MenuItem key={m} value={m}>
                {m}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {keyMissing && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {providerName(provider)} has no enabled deployment key. Save its key in the provider card above.
        </Alert>
      )}
      {message && (
        <Alert severity={message.severity} sx={{ mb: 2 }}>
          {message.text}
        </Alert>
      )}

      <Stack direction="row" spacing={1}>
        <Button
          variant="contained"
          size="small"
          disabled={!canWrite || !provider || !model || busy !== null}
          onClick={() => void save()}
          startIcon={busy === 'save' ? <CircularProgress size={14} /> : undefined}
        >
          Save
        </Button>
        {feature.test && (
          <Button
            variant="outlined"
            size="small"
            disabled={!canWrite || !provider || !model || busy !== null}
            onClick={() => void test()}
            startIcon={busy === 'test' ? <CircularProgress size={14} /> : undefined}
          >
            Test
          </Button>
        )}
        {feature.clearable && (
          <Button
            variant="text"
            size="small"
            color="inherit"
            disabled={!canWrite || !saved || busy !== null}
            onClick={() => void clear()}
          >
            Clear
          </Button>
        )}
      </Stack>
    </Paper>
  );
}

/** The section: one card per MemoriaHub feature. */
export function MemoriaHubAiFeaturesSection() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('ai_config:write');
  const [settings, setSettings] = useState<AiSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await getAiSettings());
      setError(null);
    } catch (err) {
      setError(aiErrorText(err, 'Failed to load the MemoriaHub AI features.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = useMemo(
    () => (settings ? [...settings.providers, ...settings.knownProviders] : []),
    [settings],
  );

  return (
    <Box component="section" aria-labelledby="memoriahub-ai-features-title" sx={{ mt: 4 }}>
      <Typography id="memoriahub-ai-features-title" variant="h6" component="h2" gutterBottom>
        MemoriaHub AI features
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Which provider and model each MemoriaHub feature uses. The feature switches themselves (tagging, the Picture
        Enhancer, Memories) are on their own settings pages.
      </Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        These features run through the platform AI runtime: they use the deployment key saved above, are governed by
        &ldquo;AI enabled&rdquo; and the key policy, and the model chosen here must be enabled on the AI Models page.
        Every call is recorded on the AI Usage page under the feature&rsquo;s name.
      </Alert>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {!settings && !error && <CircularProgress size={24} aria-label="Loading MemoriaHub AI features" />}
      {settings && (
        <Stack spacing={2}>
          {MEMORIAHUB_AI_FEATURES.map((feature) => (
            <FeatureCard
              key={feature.key}
              feature={feature}
              selection={settings.features?.[feature.key]}
              providers={providers}
              canWrite={canWrite}
              onSaved={() => void load()}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}
