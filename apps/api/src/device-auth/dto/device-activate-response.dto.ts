import { ApiProperty } from '@nestjs/swagger';

/**
 * Typed shape of the `clientInfo` object returned in the activation response.
 * Maps to what the Android/CLI device sends in `POST /auth/device/code`.
 */
export class DeviceClientInfoDto {
  @ApiProperty({
    description: 'Human-readable device name supplied by the requesting app',
    example: 'Oscar\'s Pixel 9',
    required: false,
  })
  deviceName?: string;

  @ApiProperty({
    description: 'User-agent string of the requesting device',
    example: 'MemoriaHub-Android/1.0',
    required: false,
  })
  userAgent?: string;

  @ApiProperty({
    description:
      'Deep-link URI the web activation page uses to redirect the user back into ' +
      'the requesting app after they approve or deny the device. ' +
      'Accepted schemes: memoriahub: or https:.',
    example: 'memoriahub://auth/device-complete',
    required: false,
  })
  returnUri?: string;
}

/**
 * Response DTO for activation page information
 */
export class DeviceActivateResponseDto {
  @ApiProperty({
    description: 'Verification URI base',
    example: 'http://localhost:3535/device',
  })
  verificationUri!: string;

  @ApiProperty({
    description: 'User verification code (if provided in query)',
    example: 'ABCD-1234',
    required: false,
  })
  userCode?: string;

  @ApiProperty({
    description: 'Client information for the device (if code is valid)',
    type: DeviceClientInfoDto,
    required: false,
  })
  clientInfo?: DeviceClientInfoDto;

  @ApiProperty({
    description: 'Expiration timestamp (if code is valid)',
    example: '2026-01-22T12:00:00Z',
    required: false,
  })
  expiresAt?: string;
}
