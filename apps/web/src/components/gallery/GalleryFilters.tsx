import { Box, ToggleButtonGroup, ToggleButton, Select, MenuItem, FormControl, InputLabel, IconButton, useMediaQuery, useTheme } from '@mui/material';
import {
  Image as ImageIcon,
  Videocam as VideoIcon,
  FilterList as FilterIcon,
  ArrowUpward as AscIcon,
  ArrowDownward as DescIcon,
} from '@mui/icons-material';

export interface FilterState {
  mediaType: 'all' | 'image' | 'video';
  sortBy: 'capturedAt' | 'createdAt';
  sortOrder: 'asc' | 'desc';
}

interface GalleryFiltersProps {
  /** Current filter state */
  filters: FilterState;
  /** Handler for filter changes */
  onFilterChange: (filters: FilterState) => void;
}

/**
 * Filter controls for the gallery
 * Media type toggle, sort field selector, sort order toggle
 */
export function GalleryFilters({ filters, onFilterChange }: GalleryFiltersProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const handleMediaTypeChange = (_: React.MouseEvent<HTMLElement>, newType: string | null) => {
    if (newType !== null) {
      onFilterChange({ ...filters, mediaType: newType as FilterState['mediaType'] });
    }
  };

  const handleSortByChange = (event: { target: { value: string } }) => {
    onFilterChange({ ...filters, sortBy: event.target.value as FilterState['sortBy'] });
  };

  const handleSortOrderToggle = () => {
    onFilterChange({
      ...filters,
      sortOrder: filters.sortOrder === 'asc' ? 'desc' : 'asc',
    });
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexWrap: 'wrap',
        mb: 2,
      }}
    >
      {/* Media type filter */}
      <ToggleButtonGroup
        value={filters.mediaType}
        exclusive
        onChange={handleMediaTypeChange}
        size="small"
        aria-label="media type filter"
      >
        <ToggleButton value="all" aria-label="all media">
          {isMobile ? <FilterIcon /> : 'All'}
        </ToggleButton>
        <ToggleButton value="image" aria-label="images only">
          <ImageIcon sx={{ mr: isMobile ? 0 : 0.5 }} />
          {!isMobile && 'Images'}
        </ToggleButton>
        <ToggleButton value="video" aria-label="videos only">
          <VideoIcon sx={{ mr: isMobile ? 0 : 0.5 }} />
          {!isMobile && 'Videos'}
        </ToggleButton>
      </ToggleButtonGroup>

      {/* Sort by selector */}
      <FormControl size="small" sx={{ minWidth: 140 }}>
        <InputLabel id="sort-by-label">Sort by</InputLabel>
        <Select
          labelId="sort-by-label"
          value={filters.sortBy}
          label="Sort by"
          onChange={handleSortByChange}
        >
          <MenuItem value="capturedAt">Capture Date</MenuItem>
          <MenuItem value="createdAt">Upload Date</MenuItem>
        </Select>
      </FormControl>

      {/* Sort order toggle */}
      <IconButton
        onClick={handleSortOrderToggle}
        size="small"
        aria-label={filters.sortOrder === 'asc' ? 'Sort ascending (oldest first)' : 'Sort descending (newest first)'}
        title={filters.sortOrder === 'asc' ? 'Oldest first' : 'Newest first'}
      >
        {filters.sortOrder === 'asc' ? <AscIcon /> : <DescIcon />}
      </IconButton>
    </Box>
  );
}
