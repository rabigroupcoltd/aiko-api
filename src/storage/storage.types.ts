import { StorageProvider } from '@prisma/client';

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

/** Subset of Express.Multer.File the providers actually need. */
export interface UploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface UploadOptions {
  /** Logical folder, e.g. `vehicles/<driverId>`. No leading or trailing slash. */
  folder?: string;
}

export interface StorageUploadResult {
  /** Publicly reachable URL of the stored object. */
  url: string;
  /** Provider-scoped identifier used for deletion. */
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
