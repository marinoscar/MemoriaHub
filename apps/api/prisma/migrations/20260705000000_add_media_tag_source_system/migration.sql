-- AlterEnum
-- ALTER TYPE ... ADD VALUE cannot run inside the same transaction as statements
-- that reference the new enum value, so this is its own migration (the follow-up
-- migration 20260705000100_add_social_media_detection does not reference 'system').
ALTER TYPE "MediaTagSource" ADD VALUE 'system';
