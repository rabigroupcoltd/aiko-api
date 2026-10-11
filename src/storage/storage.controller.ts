import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { StorageProvider } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ApiAdminErrors, ApiOkEnvelope } from '../common/swagger/api-envelope.decorator';
import { STORAGE_PROVIDER_EXAMPLE } from '../common/swagger/examples';
import { StorageService } from './storage.service';

@ApiTags('Storage')
@ApiBearerAuth('bearer')
@Controller('storage')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class StorageController {
  constructor(
    private storageService: StorageService,
    private response: ResponsesService,
  ) {}

  @Get('provider')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Which upload backend is active',
    description:
      'Admin only. `active` is resolved from STORAGE_PROVIDER at boot; `available` lists every provider the build supports.',
  })
  @ApiOkEnvelope(STORAGE_PROVIDER_EXAMPLE)
  @ApiAdminErrors()
  getProvider() {
    try {
      return this.response.success({
        active: this.storageService.activeProvider,
        available: Object.values(StorageProvider),
      });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
