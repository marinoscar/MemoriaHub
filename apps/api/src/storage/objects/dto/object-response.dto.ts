import { StorageObjectStatus } from '@prisma/client';

export interface ObjectResponseDto {
  id: string;
  name: string;
  size: string; // BigInt as string
  mimeType: string;
  status: StorageObjectStatus;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadStatusResponseDto {
  objectId: string;
  status: StorageObjectStatus;
  uploadedParts: number[];
  totalParts: number;
  uploadedBytes: string;
  totalBytes: string;
}
