import { useEffect, useState, useRef } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Paper,
  Tabs,
  Tab,
  Grid,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Switch,
  Button,
  CircularProgress,
  Alert,
  Pagination,
  Link,
  IconButton,
  Snackbar,
} from '@mui/material';
import {
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  Delete as DeleteIcon,
  Send as SendIcon,
  Tune as TuneIcon,
} from '@mui/icons-material';
import { useCircle } from '../hooks/useCircle';
import { useSearch } from '../hooks/useSearch';
import { useUserSettings } from '../hooks/useUserSettings';
import { useConversations } from '../hooks/useConversations';
import { usePeople } from '../hooks/usePeople';
import { streamMessage } from '../services/searchStream';
import { MediaResultsGrid } from '../components/media/MediaResultsGrid';
import { PersonMultiSelect } from '../components/search/PersonMultiSelect';
import type { MediaItem, MediaListMeta } from '../types/media';

// ---------------------------------------------------------------------------
// Advanced search tab
// ---------------------------------------------------------------------------

function AdvancedSearchTab() {
  const navigate = useNavigate();
  const { activeCircle } = useCircle();
  const { settings } = useUserSettings();
  const { fields, searchResults, meta, isLoadingFields, isSearching, error, fetchFields, search } =
    useSearch();
  const [filterValues, setFilterValues] = useState<Record<string, unknown>>({});
  const [page, setPage] = useState(1);

  // Apply user's visible-fields preference.
  // Empty/absent visibleFields means "show all" (default).
  const visibleFields = settings?.search?.visibleFields ?? [];
  const fieldsToRender =
    visibleFields.length > 0
      ? fields.filter((f) => visibleFields.includes(f.key))
      : fields;

  useEffect(() => {
    void fetchFields();
  }, [fetchFields]);

  const handleApply = async (p = page) => {
    if (!activeCircle) return;
    try {
      const filters: Record<string, unknown> = { ...filterValues };
      const peopleVal = filterValues['people'] as { ids: string[]; mode: 'all' | 'any' } | undefined;
      if (!peopleVal || peopleVal.ids.length === 0) {
        delete filters['people'];
      }
      await search({
        circleId: activeCircle.id,
        filters,
        page: p,
        pageSize: 20,
      });
    } catch {
      // error is set in hook
    }
  };

  const handlePageChange = async (_: React.ChangeEvent<unknown>, val: number) => {
    setPage(val);
    await handleApply(val);
  };

  const setFilter = (key: string, value: unknown) => {
    setFilterValues((prev) => ({ ...prev, [key]: value }));
  };

  const isAiNotConfigured = error?.toLowerCase().includes('not configured') ?? false;

  return (
    <Box>
      {isLoadingFields ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
            <Button
              size="small"
              startIcon={<TuneIcon />}
              onClick={() => navigate('/settings#search-fields')}
              sx={{ minHeight: 44 }}
            >
              Customize fields
            </Button>
          </Box>
        <Grid container spacing={2} sx={{ mb: 2 }}>
          {fieldsToRender.map((field) => {
            if (field.type === 'date-range') {
              return (
                <Grid key={field.key} size={{ xs: 12 }}>
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <TextField
                        label={`${field.label} from`}
                        type="date"
                        size="small"
                        fullWidth
                        value={(filterValues[`${field.key}_from`] as string) ?? ''}
                        onChange={(e) => setFilter(`${field.key}_from`, e.target.value)}
                        slotProps={{ inputLabel: { shrink: true } }}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <TextField
                        label={`${field.label} to`}
                        type="date"
                        size="small"
                        fullWidth
                        value={(filterValues[`${field.key}_to`] as string) ?? ''}
                        onChange={(e) => setFilter(`${field.key}_to`, e.target.value)}
                        slotProps={{ inputLabel: { shrink: true } }}
                      />
                    </Grid>
                  </Grid>
                </Grid>
              );
            }

            if (field.type === 'enum') {
              return (
                <Grid key={field.key} size={{ xs: 12, sm: 6, md: 4 }}>
                  <FormControl size="small" fullWidth>
                    <InputLabel>{field.label}</InputLabel>
                    <Select
                      label={field.label}
                      value={(filterValues[field.key] as string) ?? ''}
                      onChange={(e) => setFilter(field.key, e.target.value)}
                    >
                      <MenuItem value="">All</MenuItem>
                      {field.enumValues?.map((v) => (
                        <MenuItem key={v} value={v}>
                          {v}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>
              );
            }

            if (field.type === 'boolean') {
              return (
                <Grid key={field.key} size={{ xs: 12, sm: 6, md: 4 }}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={(filterValues[field.key] as boolean) ?? false}
                        onChange={(e) => setFilter(field.key, e.target.checked)}
                        size="small"
                      />
                    }
                    label={field.label}
                  />
                </Grid>
              );
            }

            if (field.type === 'person-set') {
              const personValue = (filterValues[field.key] as { ids: string[]; mode: 'all' | 'any' } | undefined)
                ?? { ids: [], mode: 'all' as const };
              return (
                <Grid key={field.key} size={{ xs: 12 }}>
                  <PersonMultiSelect
                    circleId={activeCircle?.id ?? ''}
                    value={personValue}
                    onChange={(next) => setFilter(field.key, next)}
                    label={field.label}
                  />
                </Grid>
              );
            }

            // 'string' | 'geo'
            return (
              <Grid key={field.key} size={{ xs: 12, sm: 6, md: 4 }}>
                <TextField
                  label={field.label}
                  size="small"
                  fullWidth
                  value={(filterValues[field.key] as string) ?? ''}
                  onChange={(e) => setFilter(field.key, e.target.value)}
                />
              </Grid>
            );
          })}
        </Grid>
        </>
      )}

      <Button
        variant="contained"
        disabled={!activeCircle || isSearching}
        onClick={() => void handleApply(1).then(() => setPage(1))}
        sx={{ mb: 3 }}
      >
        {isSearching ? <CircularProgress size={20} sx={{ mr: 1 }} /> : null}
        Apply
      </Button>

      {/* Errors */}
      {error && !isAiNotConfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {isAiNotConfigured && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          AI search is not configured. Admins can configure it in{' '}
          <Link component={RouterLink} to="/admin/ai-settings">
            AI Settings
          </Link>
          .
        </Alert>
      )}

      {/* Results */}
      {searchResults.length > 0 && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {meta?.totalItems ?? searchResults.length} result(s)
          </Typography>
          <MediaResultsGrid items={searchResults} />
          {meta && meta.totalPages > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
              <Pagination
                count={meta.totalPages}
                page={page}
                onChange={(e, val) => void handlePageChange(e, val)}
                color="primary"
              />
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
}

function MessageBubble({ role, content }: MessageBubbleProps) {
  const isUser = role === 'user';
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        mb: 1,
      }}
    >
      <Paper
        elevation={1}
        sx={{
          px: 2,
          py: 1,
          maxWidth: '80%',
          bgcolor: isUser ? 'primary.main' : 'background.paper',
          color: isUser ? 'primary.contrastText' : 'text.primary',
          borderRadius: 2,
        }}
      >
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {content}
        </Typography>
      </Paper>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Chat tab
// ---------------------------------------------------------------------------

function ChatTab() {
  const { activeCircle } = useCircle();
  const {
    conversations,
    activeConversation,
    loading,
    fetchConversations,
    loadConversation,
    createNew,
    updateConversation,
    removeConversation,
  } = useConversations();

  const [chatPeople, setChatPeople] = useState<{ ids: string[]; mode: 'all' | 'any' }>({ ids: [], mode: 'all' });
  const { data: peopleData } = usePeople(activeCircle?.id ?? null);

  const [showArchived, setShowArchived] = useState(false);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingToolCalls, setStreamingToolCalls] = useState<string[]>([]);
  const [streamingResults, setStreamingResults] = useState<{
    items: MediaItem[];
    meta: MediaListMeta;
  } | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeCircle) return;
    void fetchConversations({
      circleId: activeCircle.id,
      archived: showArchived ? undefined : false,
    });
  }, [activeCircle, fetchConversations, showArchived]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages, streamingText]);

  const handleSend = async () => {
    if (!input.trim() || isStreaming || !activeCircle) return;
    let content = input.trim();
    if (chatPeople.ids.length > 0 && peopleData) {
      const names = chatPeople.ids
        .map((id) => peopleData.items.find((p) => p.id === id)?.name ?? id.slice(0, 8))
        .join(', ');
      const modeWord = chatPeople.mode === 'all' ? 'all of these people' : 'any of these people';
      content = `${content}\n\n(Only include photos containing ${modeWord}: ${names})`;
    }
    setInput('');

    let convId = activeConversation?.id;
    if (!convId) {
      const conv = await createNew(activeCircle.id);
      convId = conv.id;
      await loadConversation(convId);
      await fetchConversations({ circleId: activeCircle.id });
    }

    setIsStreaming(true);
    setStreamingText('');
    setStreamingToolCalls([]);
    setStreamingResults(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      await streamMessage(
        convId,
        content,
        {
          onToken: (text) => setStreamingText((prev) => prev + text),
          onToolCall: (data) =>
            setStreamingToolCalls((prev) => [...prev, data.name]),
          onResults: (data) => setStreamingResults(data),
          onError: (data) => setChatError(data.message),
          onDone: async () => {
            await loadConversation(convId!);
            await fetchConversations({ circleId: activeCircle.id });
            setStreamingText('');
            setStreamingToolCalls([]);
            setStreamingResults(null);
          },
        },
        abort.signal,
      );
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setChatError(err.message);
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <Box sx={{ display: 'flex', gap: 2, minHeight: 500 }}>
      {/* Conversation list sidebar */}
      <Box
        sx={{
          width: 250,
          flexShrink: 0,
          display: { xs: 'none', md: 'flex' },
          flexDirection: 'column',
          gap: 1,
        }}
      >
        <Button
          variant="outlined"
          fullWidth
          onClick={() => {
            if (!activeCircle) return;
            void createNew(activeCircle.id).then((conv) => {
              void loadConversation(conv.id);
              void fetchConversations({ circleId: activeCircle.id });
            });
          }}
          disabled={!activeCircle || loading}
        >
          New Conversation
        </Button>

        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
          }
          label="Show archived"
        />

        <Box sx={{ overflowY: 'auto', flex: 1 }}>
          {conversations.map((conv) => (
            <Paper
              key={conv.id}
              variant={activeConversation?.id === conv.id ? 'elevation' : 'outlined'}
              elevation={activeConversation?.id === conv.id ? 3 : undefined}
              sx={{ p: 1, cursor: 'pointer', mb: 0.5 }}
              onClick={() => void loadConversation(conv.id)}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                  {conv.title ?? 'New conversation'}
                </Typography>
                <Box>
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      void updateConversation(conv.id, { favorite: !conv.favorite });
                    }}
                    aria-label={conv.favorite ? 'Unfavorite' : 'Favorite'}
                  >
                    {conv.favorite ? (
                      <StarIcon fontSize="small" />
                    ) : (
                      <StarBorderIcon fontSize="small" />
                    )}
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeConversation(conv.id);
                    }}
                    aria-label="Delete conversation"
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
            </Paper>
          ))}
        </Box>
      </Box>

      {/* Main chat area */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Messages */}
        <Box
          sx={{
            flex: 1,
            overflowY: 'auto',
            mb: 2,
            minHeight: 300,
            maxHeight: 500,
            p: 1,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
          }}
        >
          {!activeConversation && !isStreaming && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <Typography variant="body2" color="text.secondary">
                Start a new conversation or select one from the list.
              </Typography>
            </Box>
          )}

          {activeConversation?.messages.map((msg) => (
            <MessageBubble key={msg.id} role={msg.role} content={msg.content} />
          ))}

          {/* Streaming assistant bubble */}
          {isStreaming && (
            <Box>
              {/* Tool call chips */}
              {streamingToolCalls.length > 0 && (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                  {streamingToolCalls.map((name, i) => (
                    <Paper key={i} variant="outlined" sx={{ px: 1, py: 0.25 }}>
                      <Typography variant="caption" color="text.secondary">
                        {name}
                      </Typography>
                    </Paper>
                  ))}
                </Box>
              )}

              {streamingText && (
                <MessageBubble role="assistant" content={streamingText + '▍'} />
              )}

              {!streamingText && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1 }}>
                  <CircularProgress size={16} />
                  <Typography variant="caption" color="text.secondary">
                    Thinking…
                  </Typography>
                </Box>
              )}
            </Box>
          )}

          {/* Streaming results */}
          {streamingResults && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
                {streamingResults.meta.totalItems} result(s)
              </Typography>
              <MediaResultsGrid items={streamingResults.items} />
            </Box>
          )}

          <div ref={messagesEndRef} />
        </Box>

        {/* Composer */}
        {activeCircle && (
          <Box sx={{ mb: 1 }}>
            <PersonMultiSelect
              circleId={activeCircle.id}
              value={chatPeople}
              onChange={setChatPeople}
              label="Filter by people (optional)"
            />
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            multiline
            maxRows={4}
            size="small"
            fullWidth
            placeholder="Ask about your memories…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming || !activeCircle}
          />
          <IconButton
            color="primary"
            onClick={() => void handleSend()}
            disabled={!input.trim() || isStreaming || !activeCircle}
            aria-label="Send message"
          >
            {isStreaming ? <CircularProgress size={24} /> : <SendIcon />}
          </IconButton>
        </Box>
      </Box>

      {/* Chat error snackbar */}
      <Snackbar
        open={!!chatError}
        autoHideDuration={5000}
        onClose={() => setChatError(null)}
      >
        <Alert severity="error" onClose={() => setChatError(null)}>
          {chatError}
        </Alert>
      </Snackbar>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SearchPage — main entry
// ---------------------------------------------------------------------------

export default function SearchPage() {
  const { activeCircle } = useCircle();
  const [tabIndex, setTabIndex] = useState(0);

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to view media.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h5" component="h1" sx={{ mb: 3 }}>
        Search
      </Typography>

      <Paper sx={{ mb: 3 }}>
        <Tabs
          value={tabIndex}
          onChange={(_, v: number) => setTabIndex(v)}
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab label="Advanced" />
          <Tab label="Chat" />
        </Tabs>
      </Paper>

      {tabIndex === 0 && <AdvancedSearchTab />}
      {tabIndex === 1 && <ChatTab />}
    </Box>
  );
}
