import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsUUID,
  IsDateString,
  ValidateIf,
} from 'class-validator';
import { ShareTargetType } from '@prisma/client';

export class CreateShareDto {
  @ApiProperty({
    description: 'Target type for the share',
    enum: ShareTargetType,
    example: 'media_item',
  })
  @IsEnum(ShareTargetType)
  targetType!: ShareTargetType;

  @ApiPropertyOptional({
    description: 'UUID of the MediaItem to share (required when targetType is media_item)',
    format: 'uuid',
  })
  @ValidateIf((o: CreateShareDto) => o.targetType === ShareTargetType.media_item)
  @IsUUID()
  mediaItemId?: string;

  @ApiPropertyOptional({
    description: 'UUID of the Album to share (required when targetType is album)',
    format: 'uuid',
  })
  @ValidateIf((o: CreateShareDto) => o.targetType === ShareTargetType.album)
  @IsUUID()
  albumId?: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 expiration datetime; null or omitted means never expires',
    example: '2026-12-31T23:59:59Z',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: CreateShareDto) => o.expiresAt !== null)
  @IsDateString()
  expiresAt?: string | null;
}
