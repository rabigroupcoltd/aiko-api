import { Injectable, Logger } from '@nestjs/common';
import { StorageProvider } from '@prisma/client';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { IStorageProvider, StorageUploadResult, UploadFile, UploadOptions } from '../storage.types';
import { buildObjectKey } from '../storage.util';

@Injectable()
export class LocalStorageProvider implements IStorageProvider {
  readonly name = StorageProvider.LOCAL;

  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly root = resolve(process.env.UPLOAD_DIR || './uploads');
  private readonly baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

  async upload(file: UploadFile, options: UploadOptions = {}): Promise<StorageUploadResult> {
    const key = buildObjectKey(file.originalname, options.folder);
    const target = join(this.root, key);

    await fs.mkdir(join(target, '..'), { recursive: true });
    await fs.writeFile(target, file.buffer);
    this.logger.debug(`Stored ${key} on local disk`);

    return {
      url: `${this.baseUrl}/uploads/${key}`,
      key,
      provider: this.name,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    };
  }

  async delete(key: string): Promise<void> {
    await fs.rm(join(this.root, key), { force: true });
  }
}
