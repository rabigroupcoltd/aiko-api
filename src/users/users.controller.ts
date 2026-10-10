import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import {
  ApiAdminErrors,
  ApiConflict,
  ApiForbidden,
  ApiNotFound,
  ApiOkEnvelope,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import { USER_EXAMPLE } from '../common/swagger/examples';
import { BlockUserDto, CreateStaffDto, UpdateUserDto, UserDirectoryQueryDto } from './dto/user.dto';
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
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'SUPPORT')
  @ApiOperation({
    summary: 'List users',
    description:
      'Admin/support only — this is the whole user base, not one profile. Public user columns only, the password hash is never selected.',
  })
  @ApiOkEnvelope([USER_EXAMPLE])
  @ApiUnauthorized()
  @ApiForbidden('Requires one of the following roles: ADMIN, SUPPORT')
  async findAll() {
    try {
      const result = await this.usersService.findAll();
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('staff')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Create a staff account',
    description:
      "Admin only. The dashboard's own way to add another admin or support account, without touching the seed script or the database by hand. Password-authenticated, same as the seeded admin — the new account never walks the app's onboarding stack.",
  })
  @ApiOkEnvelope({ ...USER_EXAMPLE, roles: ['SUPPORT', 'USER'] }, { message: 'Staff account created' })
  @ApiValidationError('password must be longer than or equal to 8 characters')
  @ApiConflict('A user with this email already exists')
  @ApiAdminErrors()
  async createStaff(@Body() dto: CreateStaffDto, @CurrentUser() actor: JwtUser) {
    try {
      const result = await this.usersService.createStaff(dto, actor);
      return this.response.handle(result, { message: 'Staff account created' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('directory')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'SUPPORT')
  @ApiOperation({
    summary: 'User management list',
    description:
      'Admin/support only. One tab at a time — passengers, drivers (including those who never submitted documents) or staff — with per-tab counts, driver approval status and commission owed.',
  })
  @ApiUnauthorized()
  @ApiForbidden('Requires one of the following roles: ADMIN, SUPPORT')
  async directory(@Query() query: UserDirectoryQueryDto) {
    try {
      const result = await this.usersService.directory(query);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id/overview')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'SUPPORT')
  @ApiOperation({
    summary: 'Everything about one user',
    description:
      'Admin/support only. The account, driver profile with documents and wallet, and trip and money totals as passenger and as driver.',
  })
  @ApiParam({ name: 'id', format: 'uuid', example: USER_EXAMPLE.id })
  @ApiUnauthorized()
  @ApiForbidden('Requires one of the following roles: ADMIN, SUPPORT')
  @ApiNotFound('User not found')
  async overview(@Param('id') id: string) {
    try {
      const result = await this.usersService.overview(id);
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

  @Patch(':id/block')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Block or unblock an account',
    description:
      'Admin only. A blocked account is rejected on its very next request — see JwtStrategy — not just at its next sign-in. Anything already in flight (an open order, an active trip) is left alone; only new activity by this account stops.',
  })
  @ApiParam({ name: 'id', format: 'uuid', example: USER_EXAMPLE.id })
  @ApiOkEnvelope({ ...USER_EXAMPLE, isBlocked: true }, { message: 'Account updated' })
  @ApiNotFound('User not found')
  @ApiAdminErrors()
  async block(
    @Param('id') id: string,
    @Body() dto: BlockUserDto,
    @CurrentUser() actor: JwtUser,
  ) {
    try {
      const result = await this.usersService.block(id, dto, actor);
      return this.response.handle(result, { message: 'Account updated' });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
