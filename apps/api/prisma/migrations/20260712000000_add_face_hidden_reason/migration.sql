-- AlterTable: add hidden_reason provenance column to faces, distinguishing
-- auto-archived faces (e.g. 'auto_archive_match') from manually-archived
-- faces (null). Nullable, additive, no index required.
ALTER TABLE "faces" ADD COLUMN "hidden_reason" TEXT;
