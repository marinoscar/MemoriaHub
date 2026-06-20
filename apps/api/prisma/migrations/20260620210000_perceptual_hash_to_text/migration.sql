-- Convert perceptual_hash from signed bigint to TEXT storing an unsigned decimal string.
--
-- The dHash is an UNSIGNED 64-bit value (0 .. 2^64-1). The previous bigint
-- column was signed, so hashes with the high bit set were stored as their
-- two's-complement negative equivalent. The USING clause below reverses that
-- mapping: negative values are shifted back to their original unsigned decimal
-- representation before the column type changes to TEXT.
ALTER TABLE "media_items"
  ALTER COLUMN "perceptual_hash" TYPE TEXT
  USING (
    CASE
      WHEN "perceptual_hash" IS NULL THEN NULL
      WHEN "perceptual_hash" < 0 THEN ("perceptual_hash"::numeric + 18446744073709551616)::text
      ELSE "perceptual_hash"::text
    END
  );
