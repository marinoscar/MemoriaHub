/**
 * SearchPage — Immich-style Explore + Conversational Search
 *
 * Layout:
 * 1. Top: Prominent search bar (conversational input is the hero)
 *    - Tune icon button opens AdvancedSearchDialog for deterministic search
 * 2. Conversation thread (in-memory React state only, no persistence)
 *    - Messages as bubbles, streaming tokens append in-place
 *    - Tool call chips shown during stream
 *    - Media results rendered inline via MediaGallery
 *    - "New search" button resets messages to []
 * 3. Advanced (deterministic) search results section (if any from AdvancedSearchDialog)
 * 4. Explore rows (shown when thread is empty):
 *    - People: circular avatar row, link to /media?personId=
 *    - Places: thumbnail tiles, link to /media?locality=
 *    - Tags: thumbnail tiles, link to /media?tag=
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box,
  Typography,
  Paper,
  TextField,
  IconButton,
  Button,
  CircularProgress,
  Alert,
  Chip,
  Tooltip,
  Snackbar,
  Skeleton,
} from '@mui/material';
import {
  Send as SendIcon,
  Tune as TuneIcon,
  Add as AddIcon,
  Person as PersonIcon,
  Place as PlaceIcon,
  LocalOffer as TagIcon,
} from '@mui/icons-material';
import { useCircle } from '../hooks/useCircle';
import { usePeople } from '../hooks/usePeople';
import { streamAgent } from '../services/searchAgentStream';
import { getExplorePlaces, getExploreTags } from '../services/media';
import type { ExploreItem } from '../services/media';
import { MediaGallery } from '../components/media/MediaGallery';
import { PersonAvatar } from '../components/people/PersonAvatar';
import { AdvancedSearchDialog } from '../components/search/AdvancedSearchDialog';
import type { ChatMsg } from '../services/searchAgentStream';
import type { MediaItem, MediaListMeta } from '../types/media';

// ---------------------------------------------------------------------------
// MessageBubble
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
        elevation={isUser ? 0 : 1}
        sx={{
          px: 2,
          py: 1,
          maxWidth: '85%',
          bgcolor: isUser ? 'primary.main' : 'background.paper',
          color: isUser ? 'primary.contrastText' : 'text.primary',
          borderRadius: 2,
          border: isUser ? 'none' : 1,
          borderColor: 'divider',
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
// ExploreRow — horizontal scrolling row with section header
// ---------------------------------------------------------------------------

interface ExploreRowProps {
  title: string;
  icon: React.ReactNode;
  loading: boolean;
  children: React.ReactNode;
}

function ExploreRow({ title, icon, loading, children }: ExploreRowProps) {
  return (
    <Box sx={{ mb: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        {icon}
        <Typography variant="subtitle1" fontWeight={600}>
          {title}
        </Typography>
      </Box>
      {loading ? (
        <Box sx={{ display: 'flex', gap: 1.5, overflowX: 'auto', pb: 1 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton
              key={i}
              variant="rectangular"
              sx={{ width: 96, height: 96, borderRadius: 2, flexShrink: 0 }}
            />
          ))}
        </Box>
      ) : (
        <Box sx={{ display: 'flex', gap: 1.5, overflowX: 'auto', pb: 1, '::-webkit-scrollbar': { height: 4 } }}>
          {children}
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SearchPage
// ---------------------------------------------------------------------------

export default function SearchPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { activeCircle, activeCircleRole } = useCircle();
  const { data: peopleData, loading: peopleLoading } = usePeople(activeCircle?.id ?? null);

  // Conversational state — IN MEMORY ONLY, intentionally lost on reload
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingToolCalls, setStreamingToolCalls] = useState<string[]>([]);
  const [streamingResults, setStreamingResults] = useState<{
    items: MediaItem[];
    meta: MediaListMeta;
  } | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);

  // Advanced (deterministic) search results
  const [advancedResults, setAdvancedResults] = useState<MediaItem[] | null>(null);
  const [advancedTotal, setAdvancedTotal] = useState(0);

  // Advanced dialog
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Explore data
  const [places, setPlaces] = useState<ExploreItem[]>([]);
  const [tags, setTags] = useState<ExploreItem[]>([]);
  const [placesLoading, setPlacesLoading] = useState(false);
  const [tagsLoading, setTagsLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch explore data when circle changes
  useEffect(() => {
    if (!activeCircle) return;
    const id = activeCircle.id;

    setPlacesLoading(true);
    getExplorePlaces(id)
      .then((data) => setPlaces(data))
      .catch(() => setPlaces([]))
      .finally(() => setPlacesLoading(false));

    setTagsLoading(true);
    getExploreTags(id)
      .then((data) => setTags(data))
      .catch(() => setTags([]))
      .finally(() => setTagsLoading(false));
  }, [activeCircle]);

  // Scroll to bottom when messages or streaming text change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const handleSend = useCallback(async (overrideInput?: string) => {
    const text = (overrideInput ?? input).trim();
    if (!text || isStreaming || !activeCircle) return;

    setInput('');
    const userMsg: ChatMsg = { role: 'user', content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);

    setIsStreaming(true);
    setStreamingText('');
    setStreamingToolCalls([]);
    setStreamingResults(null);

    const abort = new AbortController();
    abortRef.current = abort;

    let finalText = '';

    try {
      await streamAgent(
        { circleId: activeCircle.id, messages: nextMessages },
        {
          onToken: (chunk) => {
            finalText += chunk;
            setStreamingText((prev) => prev + chunk);
          },
          onToolCall: (data) => {
            setStreamingToolCalls((prev) => [...prev, data.name]);
          },
          onResults: (data) => {
            setStreamingResults(data);
          },
          onDone: () => {
            // Commit the streamed assistant message to state
            if (finalText) {
              setMessages((prev) => [...prev, { role: 'assistant', content: finalText }]);
            }
            setStreamingText('');
            setStreamingToolCalls([]);
            setStreamingResults(null);
          },
          onError: (data) => {
            setChatError(data.message);
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
  }, [activeCircle, input, isStreaming, messages]);

  // Support ?q= query param to kick off an initial search
  useEffect(() => {
    const q = searchParams.get('q');
    if (q && !isStreaming && messages.length === 0) {
      setInput(q);
      // Kick off after a tick so input state is set
      setTimeout(() => {
        void handleSend(q);
      }, 0);
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleNewSearch = () => {
    if (isStreaming) {
      abortRef.current?.abort();
    }
    setMessages([]);
    setStreamingText('');
    setStreamingToolCalls([]);
    setStreamingResults(null);
    setAdvancedResults(null);
    setChatError(null);
    setInput('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleAdvancedResults = (items: MediaItem[], total: number) => {
    setAdvancedResults(items);
    setAdvancedTotal(total);
    // Clear chat results so the two result sections don't compete
    setMessages([]);
    setStreamingResults(null);
  };

  const hasConversation = messages.length > 0 || isStreaming;
  const showExplore = !hasConversation && advancedResults === null;
  const labeledPeople = (peopleData?.items ?? []).filter((p) => p.name != null).slice(0, 10);

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to search your memories.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 900, mx: 'auto' }}>
      {/* ----------------------------------------------------------------- */}
      {/* Hero search bar */}
      {/* ----------------------------------------------------------------- */}
      <Box sx={{ display: 'flex', gap: 1, mb: 3, alignItems: 'flex-end' }}>
        <TextField
          inputRef={inputRef}
          multiline
          maxRows={4}
          size="medium"
          fullWidth
          placeholder="Search your memories…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          aria-label="Conversational search input"
          sx={{
            '& .MuiOutlinedInput-root': {
              borderRadius: 3,
            },
          }}
        />
        <Tooltip title="Advanced filter options">
          <IconButton
            onClick={() => setAdvancedOpen(true)}
            aria-label="Open advanced search options"
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              p: 1.25,
              minHeight: 44,
              minWidth: 44,
              flexShrink: 0,
            }}
          >
            <TuneIcon />
          </IconButton>
        </Tooltip>
        <IconButton
          color="primary"
          onClick={() => void handleSend()}
          disabled={!input.trim() || isStreaming}
          aria-label="Send message"
          sx={{
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            borderRadius: 2,
            p: 1.25,
            minHeight: 44,
            minWidth: 44,
            flexShrink: 0,
            '&:hover': { bgcolor: 'primary.dark' },
            '&:disabled': { bgcolor: 'action.disabledBackground' },
          }}
        >
          {isStreaming ? <CircularProgress size={22} sx={{ color: 'inherit' }} /> : <SendIcon />}
        </IconButton>
      </Box>

      {/* ----------------------------------------------------------------- */}
      {/* Conversation thread */}
      {/* ----------------------------------------------------------------- */}
      {hasConversation && (
        <Box sx={{ mb: 3 }}>
          {/* New search control */}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={handleNewSearch}
              variant="outlined"
              sx={{ minHeight: 36 }}
            >
              New search
            </Button>
          </Box>

          {/* Messages */}
          <Box sx={{ display: 'flex', flexDirection: 'column', mb: 2 }}>
            {messages.map((msg, i) => (
              <MessageBubble key={i} role={msg.role} content={msg.content} />
            ))}

            {/* Streaming assistant response */}
            {isStreaming && (
              <Box>
                {/* Tool call chips */}
                {streamingToolCalls.length > 0 && (
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1, pl: 0.5 }}>
                    {streamingToolCalls.map((name, i) => (
                      <Chip
                        key={i}
                        label={name}
                        size="small"
                        variant="outlined"
                        color="secondary"
                        sx={{ fontSize: '0.7rem' }}
                      />
                    ))}
                  </Box>
                )}

                {streamingText ? (
                  <MessageBubble role="assistant" content={streamingText + '▍'} />
                ) : (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1, mb: 1 }}>
                    <CircularProgress size={16} />
                    <Typography variant="caption" color="text.secondary">
                      Searching your memories…
                    </Typography>
                  </Box>
                )}
              </Box>
            )}

            <div ref={messagesEndRef} />
          </Box>

          {/* Streaming results */}
          {streamingResults && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {streamingResults.meta.totalItems} result(s)
              </Typography>
              <MediaGallery
                items={streamingResults.items}
                isLoading={false}
                circleId={activeCircle.id}
                activeCircleRole={activeCircleRole}
                emptyState={
                  <Typography variant="body2" color="text.secondary">
                    No results found.
                  </Typography>
                }
                onChange={() => {
                  setStreamingResults(null);
                }}
              />
            </Box>
          )}
        </Box>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Advanced (deterministic) search results */}
      {/* ----------------------------------------------------------------- */}
      {advancedResults !== null && (
        <Box sx={{ mb: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {advancedTotal} filter result(s)
            </Typography>
            <Button size="small" onClick={handleNewSearch} sx={{ minHeight: 36 }}>
              Clear results
            </Button>
          </Box>
          <MediaGallery
            items={advancedResults}
            isLoading={false}
            circleId={activeCircle.id}
            activeCircleRole={activeCircleRole}
            emptyState={
              <Typography variant="body2" color="text.secondary">
                No results matched your filters.
              </Typography>
            }
            onChange={() => {
              setAdvancedResults(null);
            }}
          />
        </Box>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Explore rows — visible when no conversation and no advanced results */}
      {/* ----------------------------------------------------------------- */}
      {showExplore && (
        <Box>
          {/* People */}
          {(peopleLoading || labeledPeople.length > 0) && (
            <ExploreRow
              title="People"
              icon={<PersonIcon sx={{ color: 'text.secondary' }} />}
              loading={peopleLoading}
            >
              {labeledPeople.map((person) => (
                <Box
                  key={person.id}
                  onClick={() => navigate(`/media?personId=${person.id}`)}
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 0.5,
                    cursor: 'pointer',
                    flexShrink: 0,
                    width: 80,
                    '&:hover': { opacity: 0.8 },
                  }}
                  role="button"
                  aria-label={`View photos of ${person.name}`}
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/media?personId=${person.id}`); }}
                >
                  <PersonAvatar person={person} size={64} />
                  <Typography
                    variant="caption"
                    align="center"
                    sx={{
                      maxWidth: 76,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'block',
                    }}
                  >
                    {person.name}
                  </Typography>
                </Box>
              ))}
            </ExploreRow>
          )}

          {/* Places */}
          <ExploreRow
            title="Places"
            icon={<PlaceIcon sx={{ color: 'text.secondary' }} />}
            loading={placesLoading}
          >
            {places.slice(0, 12).map((place) => (
              <Box
                key={place.name}
                onClick={() => navigate(`/media?locality=${encodeURIComponent(place.name)}`)}
                sx={{
                  flexShrink: 0,
                  width: 96,
                  cursor: 'pointer',
                  borderRadius: 2,
                  overflow: 'hidden',
                  '&:hover': { opacity: 0.85 },
                }}
                role="button"
                aria-label={`Browse photos from ${place.name}`}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/media?locality=${encodeURIComponent(place.name)}`); }}
              >
                <Box
                  sx={{
                    width: 96,
                    height: 96,
                    bgcolor: 'action.hover',
                    position: 'relative',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  {place.coverThumbnailUrl ? (
                    <Box
                      component="img"
                      src={place.coverThumbnailUrl}
                      alt={place.name}
                      sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <Box sx={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <PlaceIcon sx={{ color: 'text.disabled', fontSize: 32 }} />
                    </Box>
                  )}
                </Box>
                <Typography variant="caption" sx={{ display: 'block', mt: 0.5, px: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {place.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
                  {place.count}
                </Typography>
              </Box>
            ))}
            {places.length === 0 && !placesLoading && (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                No places found. Add location data to your media.
              </Typography>
            )}
          </ExploreRow>

          {/* Tags */}
          <ExploreRow
            title="Tags"
            icon={<TagIcon sx={{ color: 'text.secondary' }} />}
            loading={tagsLoading}
          >
            {tags.slice(0, 12).map((tag) => (
              <Box
                key={tag.name}
                onClick={() => navigate(`/media?tag=${encodeURIComponent(tag.name)}`)}
                sx={{
                  flexShrink: 0,
                  width: 96,
                  cursor: 'pointer',
                  borderRadius: 2,
                  overflow: 'hidden',
                  '&:hover': { opacity: 0.85 },
                }}
                role="button"
                aria-label={`Browse photos tagged ${tag.name}`}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/media?tag=${encodeURIComponent(tag.name)}`); }}
              >
                <Box
                  sx={{
                    width: 96,
                    height: 96,
                    bgcolor: 'action.hover',
                    position: 'relative',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  {tag.coverThumbnailUrl ? (
                    <Box
                      component="img"
                      src={tag.coverThumbnailUrl}
                      alt={tag.name}
                      sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <Box sx={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <TagIcon sx={{ color: 'text.disabled', fontSize: 32 }} />
                    </Box>
                  )}
                </Box>
                <Typography variant="caption" sx={{ display: 'block', mt: 0.5, px: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tag.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
                  {tag.count}
                </Typography>
              </Box>
            ))}
            {tags.length === 0 && !tagsLoading && (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                No tags yet. Tag your photos to see them here.
              </Typography>
            )}
          </ExploreRow>
        </Box>
      )}

      {/* Advanced search dialog */}
      <AdvancedSearchDialog
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        circleId={activeCircle.id}
        onResults={handleAdvancedResults}
      />

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
