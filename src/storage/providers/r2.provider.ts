import { Injectable } from '@nestjs/common';
import { StorageProvider } from '@prisma/client';
import { S3CompatibleStorageProvider } from './s3-compatible.provider';

/**
 * Cloudflare R2. Buckets are not publicly readable by default — set
 * R2_PUBLIC_URL to the bucket's public r2.dev domain or your custom domain.
 */
@Injectable()
export class R2StorageProvider extends S3CompatibleStorageProvider {
  readonly name = StorageProvider.CLOUDFLARE_R2;

  constructor() {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
    super({
      region: 'auto',
      bucket: process.env.R2_BUCKET || '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      endpoint: process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      publicBaseUrl: process.env.R2_PUBLIC_URL,
    });
  }

  protected buildPublicUrl(key: string): string {
    const base = this.config.publicBaseUrl || `${this.config.endpoint}/${this.config.bucket}`;
    return `${base.replace(/\/$/, '')}/${key}`;
  }
}
