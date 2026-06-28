import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsUUID,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateIf,
} from 'class-validator';

export type BulkShareAction = 'revoke' | 'set_expiration' | 'delete';

export class BulkShareDto {
  @ApiProperty({
    description: 'UUIDs of shares to act on (1–500)',
    type: [String],
    example: ['a1b2c3d4-...'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids!: string[];

  @ApiProperty({
    description: 'Action to perform on all selected shares',
    enum: ['revoke', 'set_expiration', 'delete'] as const,
  })
  @IsEnum(['revoke', 'set_expiration', 'delete'] as const)
  action!: BulkShareAction;

  @ApiPropertyOptional({
    description: 'New expiration datetime; null clears expiration. Required when action is set_expiration.',
    nullable: true,
  })
  @ValidateIf((o: BulkShareDto) => o.action === 'set_expiration' && o.expiresAt !== null)
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}
