// The gate moved into the media slice with RETRO-J10 (#624) so the slices that registered their upload
// fan-out from the app can move too; this path stays so the remaining importers do not change.
export { featureSkipReason } from '@marinoscar/memoriahub-api/media';
