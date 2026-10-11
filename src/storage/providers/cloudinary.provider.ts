import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { StorageProvider } from '@prisma/client';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { IStorageProvider, StorageUploadResult, UploadFile, UploadOptions } from '../storage.types';
import { sanitiseSegment } from '../storage.util';

@Injectable()
export class CloudinaryStorageProvider implements IStorageProvider {
  readonly name = StorageProvider.CLOUDINARY;

  private readonly logger = new Logger(CloudinaryStorageProvider.name);

  constructor() {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  async upload(file: UploadFile, options: UploadOptions = {}): Promise<StorageUploadResult> {
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: options.folder ? sanitiseSegment(options.folder) : undefined,
          resource_type: 'auto',
        },
        (error, response) => {
          if (error || !response) return reject(error || new Error('Empty Cloudinary response'));
          resolve(response);
        },
      );
      stream.end(file.buffer);
    }).catch((error) => {
      this.logger.error(`Cloudinary upload failed: ${error?.message}`);
      throw new InternalServerErrorException('Image upload failed');
    });

    return {
      url: result.secure_url,
      key: result.public_id,
      provider: this.name,
      mimeType: file.mimetype,
      sizeBytes: result.bytes ?? file.size,
    };
  }

  async delete(key: string): Promise<void> {
    await cloudinary.uploader.destroy(key, { invalidate: true });
  }
}
