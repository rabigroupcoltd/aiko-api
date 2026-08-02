import { Injectable } from '@nestjs/common';
import { StorageProvider } from '@prisma/client';
import { S3CompatibleStorageProvider } from './s3-compatible.provider';

@Injectable()
export class S3StorageProvider extends S3CompatibleStorageProvider {
  readonly name = StorageProvider.S3;

  constructor() {
    super({
      region: process.env.AWS_REGION || 'us-east-1',
      bucket: process.env.AWS_S3_BUCKET || '',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      publicBaseUrl: process.env.AWS_S3_PUBLIC_URL,
    });
  }

  protected buildPublicUrl(key: string): string {
    if (this.config.publicBaseUrl) {
      return `${this.config.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    }
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${key}`;
  }
}
