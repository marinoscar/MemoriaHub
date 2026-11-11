// `applyLocation` and its patch type live in the media slice (the gallery service writes locations
// and `location` depends on `media`); re-exported so this slice keeps its public names.
export { applyLocation, type ApplyLocationPatch } from '../../media/index.js';
