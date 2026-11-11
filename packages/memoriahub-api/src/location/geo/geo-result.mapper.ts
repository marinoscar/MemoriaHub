// The geo column mapping lives in the media slice (the gallery service clears and writes locations
// and `location` depends on `media`); re-exported so this slice keeps its public names.
export { GEO_CLEAR_COLUMNS, geoResultToMediaColumns } from '../../media/index.js';
