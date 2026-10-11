import { FileTypeValidator, MaxFileSizeValidator, ParseFilePipe } from '@nestjs/common';
import { memoryStorage } from 'multer';

export const MAX_IMAGE_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
export const MAX_VEHICLE_PHOTOS = Number(process.env.MAX_VEHICLE_PHOTOS || 6);

export const imageUploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_VEHICLE_PHOTOS },
};

export const imageFilePipe = new ParseFilePipe({
  fileIsRequired: false,
  validators: [
    new MaxFileSizeValidator({ maxSize: MAX_IMAGE_BYTES }),
    new FileTypeValidator({ fileType: /^image\/(jpeg|jpg|png|webp|heic|heif)$/ }),
  ],
});
