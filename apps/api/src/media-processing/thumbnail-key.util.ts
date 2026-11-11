// The thumbnail storage-key convention (issue #434) lives in `@marinoscar/memoriahub-api/media`
// (RETRO-J5): the thumbnail jobs and the post-upload pipeline derive keys from the same functions.
export {
  THUMBNAIL_KEY_PREFIX,
  thumbnailKeyPrefixFor,
  buildThumbnailKey,
  thumbnailVersionFromBytes,
  randomThumbnailVersion,
  thumbnailVersionForJob,
} from '@marinoscar/memoriahub-api/media';
