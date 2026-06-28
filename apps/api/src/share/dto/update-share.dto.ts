import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, ValidateIf } from 'class-validator';

export class UpdateShareDto {
  @ApiProperty({
    description: 'New expiration datetime; null clears expiration (never expires)',
    example: '2026-12-31T23:59:59Z',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: UpdateShareDto) => o.expiresAt !== null)
  @IsDateString()
  expiresAt!: string | null;
}
