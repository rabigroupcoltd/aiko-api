import { StorageProvider } from '@prisma/client';

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

export interface UploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface UploadOptions {
  folder?: string;
}

export interface StorageUploadResult {
  url: string;
  key: string;
  provider: StorageProvider;
  mimeType: string;
  sizeBytes: number;
}

export interface IStorageProvider {
  readonly name: StorageProvider;
  upload(file: UploadFile, options?: UploadOptions): Promise<StorageUploadResult>;
  delete(key: string): Promise<void>;
}
