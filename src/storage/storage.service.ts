import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { StorageProvider } from '@prisma/client';
import { CloudinaryStorageProvider } from './providers/cloudinary.provider';
import { LocalStorageProvider } from './providers/local.provider';
import { R2StorageProvider } from './providers/r2.provider';
import { S3StorageProvider } from './providers/s3.provider';
import { IStorageProvider, StorageUploadResult, UploadFile, UploadOptions } from './storage.types';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly registry: Record<StorageProvider, IStorageProvider>;

  constructor(
    local: LocalStorageProvider,
    cloudinary: CloudinaryStorageProvider,
    s3: S3StorageProvider,
    r2: R2StorageProvider,
  ) {
    this.registry = {
      [StorageProvider.LOCAL]: local,
      [StorageProvider.CLOUDINARY]: cloudinary,
      [StorageProvider.S3]: s3,
      [StorageProvider.CLOUDFLARE_R2]: r2,
    };
  }

  onModuleInit() {
    this.logger.log(`Active storage provider: ${this.activeProvider}`);
  }

  get activeProvider(): StorageProvider {
    const configured = (process.env.STORAGE_PROVIDER || '').toUpperCase();
    if (configured in StorageProvider) {
      return configured as StorageProvider;
    }
    if (configured) {
      this.logger.warn(`Unknown STORAGE_PROVIDER "${configured}" — falling back to LOCAL`);
    }
    return StorageProvider.LOCAL;
  }

  upload(file: UploadFile, options?: UploadOptions): Promise<StorageUploadResult> {
    return this.registry[this.activeProvider].upload(file, options);
  }

  uploadMany(files: UploadFile[], options?: UploadOptions): Promise<StorageUploadResult[]> {
    return Promise.all(files.map((file) => this.upload(file, options)));
  }

  async delete(key: string, provider: StorageProvider): Promise<void> {
    try {
      await this.registry[provider].delete(key);
    } catch (error: any) {
      this.logger.warn(`Failed to delete ${key} from ${provider}: ${error?.message}`);
    }
  }
}
