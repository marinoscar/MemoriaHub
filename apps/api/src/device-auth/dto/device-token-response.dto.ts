import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for successful device authorization.
 *
 * One shape for both credential kinds (RFC 8628 §3.5: the token response is
 * an OAuth 2.0 token response). `credentialType` says which kind was issued:
 * `'pat'` when the device requested `clientInfo.tokenType: "pat"`, otherwise
 * `'session'`. `expiresAt`, `tokenId` and `tokenName` are populated only for
 * a PAT (issue #499; contract: docs/specs/android-media-sync.md §6.7).
 *
 * `tokenType` is the OAuth literal `Bearer` for BOTH kinds — a PAT is
 * presented as `Authorization: Bearer pat_...`. Clients tell the two apart by
 * `credentialType`, never by an empty `refreshToken`.
 */
export class DeviceTokenResponseDto {
  @ApiProperty({
    description:
      'The credential to present as `Authorization: Bearer <token>`. A signed JWT for a ' +
      'session credential; an opaque `pat_...` token when `credentialType` is `pat`.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      'Refresh token for obtaining new access tokens. Empty string for a personal access ' +
      'token, which has no refresh token by design (re-running the device login renews it).',
    example: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
  })
  refreshToken!: string;

  @ApiProperty({
    description:
      'OAuth 2.0 token type, always `Bearer` for both credential kinds. Branch on ' +
      '`credentialType` to tell a PAT from a session.',
    example: 'Bearer',
  })
  tokenType!: string;

  @ApiProperty({
    description:
      'Token lifetime in seconds: `DEVICE_TOKEN_EXPIRY_DAYS` for a session, ' +
      '`deviceAuth.patTtlDays` (90 days by default) for a PAT.',
    example: 604800,
  })
  expiresIn!: number;

  @ApiProperty({
    description:
      'Which credential was issued: `pat` when the device requested ' +
      '`clientInfo.tokenType: "pat"` (a personal access token), otherwise `session` ' +
      '(a JWT plus refresh token). Clients must branch on this field; the Android ' +
      'companion refuses anything but `pat`.',
    enum: ['pat', 'session'],
    example: 'pat',
  })
  credentialType!: 'pat' | 'session';

  @ApiProperty({
    description: 'Absolute PAT expiry, ISO-8601. PAT only.',
    example: '2026-12-31T12:00:00.000Z',
    required: false,
  })
  expiresAt?: string;

  @ApiProperty({
    description:
      'Id of the issued personal access token, for `DELETE /api/pat/{id}`. PAT only. Not a secret.',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  tokenId?: string;

  @ApiProperty({
    description:
      'Display name of the issued personal access token (from `clientInfo.name`). PAT only.',
    example: 'MemoriaHub CLI',
    required: false,
  })
  tokenName?: string;
}
