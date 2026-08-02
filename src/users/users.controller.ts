import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ApiForbidden,
  ApiNotFound,
  ApiOkEnvelope,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import { USER_EXAMPLE } from '../common/swagger/examples';
import { UpdateUserDto } from './dto/user.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth('bearer')
@Controller('users')
@UseGuards(AuthGuard('jwt'))
export class UsersController {
  constructor(
    private usersService: UsersService,
    private response: ResponsesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List users',
    description: 'Public user columns only — the password hash is never selected.',
  })
  @ApiOkEnvelope([USER_EXAMPLE])
  @ApiUnauthorized()
  async findAll() {
    try {
      const result = await this.usersService.findAll();
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one user' })
  @ApiParam({ name: 'id', format: 'uuid', example: USER_EXAMPLE.id })
  @ApiOkEnvelope(USER_EXAMPLE)
  @ApiUnauthorized()
  @ApiNotFound('User not found')
  async findOne(@Param('id') id: string) {
    try {
      const result = await this.usersService.findOne(id);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a profile',
    description: 'A user may only update their own record.',
  })
  @ApiParam({ name: 'id', format: 'uuid', example: USER_EXAMPLE.id })
  @ApiOkEnvelope({ ...USER_EXAMPLE, name: 'Ada Obi-Nwosu' }, { message: 'Profile updated' })
  @ApiValidationError('phone must be a valid phone number')
  @ApiUnauthorized()
  @ApiForbidden('You can only update your own profile')
  @ApiNotFound('User not found')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser('sub') currentUserId: string,
  ) {
    try {
      const result = await this.usersService.update(id, dto, currentUserId);
      return this.response.handle(result, { message: 'Profile updated' });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
