import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import {
  ApiAdminErrors,
  ApiOkEnvelope,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import { PLATFORM_SETTING_KEYS } from './platform-settings.constants';
import { UpdatePlatformSettingDto } from './dto/platform-settings.dto';
import { PlatformSettingsService } from './platform-settings.service';

const SETTINGS_EXAMPLE = [
  {
    key: 'FARE_ROUNDING_STEP',
    value: 10,
    description: 'Every fare is rounded up to the nearest multiple of this many currency units.',
    updatedAt: null,
  },
];

@ApiTags('Settings')
@ApiBearerAuth('bearer')
@Controller('settings')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
export class PlatformSettingsController {
  constructor(
    private settings: PlatformSettingsService,
    private response: ResponsesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List every platform setting and its current value' })
  @ApiOkEnvelope(SETTINGS_EXAMPLE)
  @ApiAdminErrors()
  async findAll() {
    try {
      const result = await this.settings.findAll();
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':key')
  @ApiOperation({
    summary: 'Change one setting',
    description: 'Takes effect on the very next request — nothing needs a restart.',
  })
  @ApiParam({ name: 'key', enum: PLATFORM_SETTING_KEYS, example: 'FARE_ROUNDING_STEP' })
  @ApiOkEnvelope(SETTINGS_EXAMPLE[0], { message: 'Setting updated' })
  @ApiValidationError('Unknown setting "NOT_A_REAL_KEY"')
  @ApiAdminErrors()
  async update(@Param('key') key: string, @Body() dto: UpdatePlatformSettingDto) {
    try {
      const result = await this.settings.update(key, dto.value);
      return this.response.handle(result, { message: 'Setting updated' });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
