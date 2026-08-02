import { InternalServerErrorException, Logger } from '@nestjs/common';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { StorageProvider } from '@prisma/client';
import { IStorageProvider, StorageUploadResult, UploadFile, UploadOptions } from '../storage.types';
import { buildObjectKey } from '../storage.util';

export interface S3CompatibleConfig {
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Custom endpoint — required for R2, omitted for AWS S3. */
  endpoint?: string;
  forcePathStyle?: boolean;
  /** CDN / custom domain used to build the public URL. */
  publicBaseUrl?: string;
}

/**
 * Shared implementation for any S3 API compatible store.
 * AWS S3 and Cloudflare R2 differ only in endpoint and URL construction.
 */
export abstract class S3CompatibleStorageProvider implements IStorageProvider {
  abstract readonly name: StorageProvider;

  protected readonly logger = new Logger(this.constructor.name);
  private client?: S3Client;

  protected constructor(protected readonly config: S3CompatibleConfig) {}

  /** Lazy so a misconfigured inactive provider never breaks bootstrap. */
  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        region: this.config.region,
        endpoint: this.config.endpoint,
        forcePathStyle: this.config.forcePathStyle ?? false,
        credentials:
          this.config.accessKeyId && this.config.secretAccessKey
            ? {
                accessKeyId: this.config.accessKeyId,
                secretAccessKey: this.config.secretAccessKey,
              }
            : undefined,
      });
    }
    return this.client;
  }

  async upload(file: UploadFile, options: UploadOptions = {}): Promise<StorageUploadResult> {
    if (!this.config.bucket) {
      throw new InternalServerErrorException(`${this.name} bucket is not configured`);
    }

    const key = buildObjectKey(file.originalname, options.folder);

    try {
      await this.getClient().send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
          ContentLength: file.size,
        }),
      );
    } catch (error: any) {
      this.logger.error(`${this.name} upload failed: ${error?.message}`);
      throw new InternalServerErrorException('Image upload failed');
    }

    return {
      url: this.buildPublicUrl(key),
      key,
      provider: this.name,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    };
  }

  async delete(key: string): Promise<void> {
    await this.getClient().send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  protected abstract buildPublicUrl(key: string): string;
}
