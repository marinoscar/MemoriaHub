import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

export const listFoldersQuerySchema = z.object({
  /** OneDrive folder path relative to the drive root; omit for the root. */
  path: z.string().max(2048).optional(),
});

export class ListFoldersQueryDto extends createZodDto(listFoldersQuerySchema) {}

export class OneDriveConnectionStatusDto {
  @ApiProperty({ description: 'Whether the caller has an active OneDrive connection' })
  connected!: boolean;

  @ApiProperty({ required: false, description: 'Connected Microsoft account email (display only)' })
  microsoftEmail?: string;

  @ApiProperty({ required: false, description: 'When the connection was established' })
  connectedAt?: Date;
}

export class OneDriveFolderDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'Path relative to the drive root' })
  path!: string;
}
