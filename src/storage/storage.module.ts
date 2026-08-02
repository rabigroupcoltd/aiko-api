import { Global, Module } from '@nestjs/common';
import { CloudinaryStorageProvider } from './providers/cloudinary.provider';
import { LocalStorageProvider } from './providers/local.provider';
import { R2StorageProvider } from './providers/r2.provider';
import { S3StorageProvider } from './providers/s3.provider';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Global()
@Module({
  controllers: [StorageController],
  providers: [
    LocalStorageProvider,
    CloudinaryStorageProvider,
    S3StorageProvider,
    R2StorageProvider,
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
