import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO for a newly created node credential (includes the raw token,
 * shown only once — it is never retrievable again).
 */
export class NodeCredentialCreatedResponseDto {
  @ApiProperty({ description: 'The raw token value - shown only once, store securely' })
  token!: string;

  @ApiProperty({ description: 'Credential ID (UUID)' })
  id!: string;

  @ApiProperty({ description: 'Human-readable name for this credential' })
  name!: string;

  @ApiProperty({ description: 'Token prefix for identification (e.g. nod_ab12)' })
  tokenPrefix!: string;

  @ApiPropertyOptional({ description: 'ISO 8601 expiry timestamp, null if the credential never expires' })
  expiresAt!: string | null;

  @ApiProperty({ description: 'ISO 8601 creation timestamp' })
  createdAt!: string;
}

/**
 * Response DTO for a single node credential in a listing (raw token and hash
 * are never returned).
 */
export class NodeCredentialListItemDto {
  @ApiProperty({ description: 'Credential ID (UUID)' })
  id!: string;

  @ApiProperty({ description: 'Human-readable name for this credential' })
  name!: string;

  @ApiProperty({ description: 'Token prefix for identification (e.g. nod_ab12)' })
  tokenPrefix!: string;

  @ApiPropertyOptional({ description: 'ISO 8601 expiry timestamp, null if the credential never expires' })
  expiresAt!: string | null;

  @ApiPropertyOptional({ description: 'ISO 8601 timestamp of last use, null if never used' })
  lastUsedAt!: string | null;

  @ApiProperty({ description: 'ISO 8601 creation timestamp' })
  createdAt!: string;

  @ApiPropertyOptional({ description: 'ISO 8601 revocation timestamp, null if not revoked' })
  revokedAt!: string | null;
}

/**
 * Admin listing item: a node credential annotated with its owning user's
 * email/display name (raw token and hash are never returned).
 */
export class AdminNodeCredentialListItemDto extends NodeCredentialListItemDto {
  @ApiProperty({ description: 'Owning user ID (UUID)' })
  userId!: string;

  @ApiProperty({ description: 'Owning user email' })
  ownerEmail!: string;

  @ApiPropertyOptional({ description: 'Owning user display name, null if not set' })
  ownerDisplayName!: string | null;
}
